import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { inspect } from "util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * mutiro-claude-bridge.ts
 *
 * A Mutiro Chatbridge <-> Claude Agent SDK adapter.
 *
 * It:
 * - spawns `mutiro agent host --mode=bridge`
 * - speaks NDJSON with the host over stdio
 * - keeps one Claude Agent SDK session per Mutiro conversation (resumed by session_id)
 * - exposes Mutiro bridge operations as MCP tools inside Claude
 * - keeps Claude Code's full built-in tool surface (Bash, Read, Edit, Grep, WebFetch, ...)
 *
 * Usage:
 *   npx tsx mutiro-claude-bridge.ts [path/to/agent/directory]
 */

const PROTOCOL_VERSION = "mutiro.agent.bridge.v1";

const TYPE_URLS = {
  addReactionRequest: "type.googleapis.com/mutiro.messaging.AddReactionRequest",
  bridgeCommandResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeCommandResult",
  bridgeInitializeCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeInitializeCommand",
  bridgeMediaUploadCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeMediaUploadCommand",
  bridgeSendMessageCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSendMessageCommand",
  bridgeSendVoiceMessageCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSendVoiceMessageCommand",
  bridgeMessageObservedResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeMessageObservedResult",
  bridgeSessionObservedResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSessionObservedResult",
  bridgeSessionSnapshotResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSessionSnapshotResult",
  bridgeSubscriptionSetCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeSubscriptionSetCommand",
  bridgeTaskResult: "type.googleapis.com/mutiro.chatbridge.ChatBridgeTaskResult",
  bridgeTurnEndCommand: "type.googleapis.com/mutiro.chatbridge.ChatBridgeTurnEndCommand",
  forwardMessageRequest: "type.googleapis.com/mutiro.messaging.ForwardMessageRequest",
  recallGetRequest: "type.googleapis.com/mutiro.recall.RecallGetRequest",
  recallSearchRequest: "type.googleapis.com/mutiro.recall.RecallSearchRequest",
  sendSignalRequest: "type.googleapis.com/mutiro.signal.SendSignalRequest",
} as const;

const OPTIONAL_CAPABILITIES = [
  "message.send_voice",
  "signal.emit",
  "recall.search",
  "recall.get",
  "media.upload",
];

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: any) => void;
};

type SessionState = {
  // One Mutiro conversation maps to one Claude Agent SDK session. We capture
  // the SDK-issued session_id from the `system.init` message and pass it via
  // `resume` on later turns to preserve continuity without replaying history.
  claudeSessionId: string | undefined;
  outputText: string;
  currentMessageId: string;
  recentMessages: any[];
  sendMessageInvoked: boolean;
};

type BridgeExtras = {
  request_id?: string;
  conversation_id?: string;
  message_id?: string;
  reply_to_message_id?: string;
};

type ObservedTurn = {
  conversationId: string;
  messageId: string;
  replyToMessageId?: string;
  senderUsername: string;
  text: string;
};

const generateId = () => Math.random().toString(36).substring(2, 15);
const MAX_RECENT_MESSAGES = 30;

const toolTextResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

const shortMessageId = (value?: string) => {
  const id = (value || "").trim();
  return id.length <= 8 ? id : id.slice(-8);
};

/**
 * Converts a normalized bridge message into plain text for the LLM.
 *
 * See pi-brain's mutiro-pi-bridge.ts for the full part-type table. The host
 * digests wire-format messages into `{ text?, parts?, ... }` where `parts` is
 * an array of flat objects discriminated by `type`.
 */
const REACTION_QUOTE_MAX_CHARS = 160;

const truncateReactionQuote = (raw: string): string => {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= REACTION_QUOTE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, REACTION_QUOTE_MAX_CHARS - 1).trimEnd()}…`;
};

const extractBridgeMessageText = (message?: any, replyToMessagePreview?: string) => {
  if (!message) return "";
  const replyPreview = (replyToMessagePreview || "").trim();

  const parts: string[] = [];
  const push = (value?: string) => {
    const trimmed = (value || "").trim();
    if (trimmed) parts.push(trimmed);
  };

  push(message.text);

  for (const part of Array.isArray(message.parts) ? message.parts : []) {
    if (!part || typeof part !== "object") continue;

    switch (part.type) {
      case "text":
        push(part.text);
        break;
      case "audio":
        push(part.transcript);
        break;
      case "card":
        push(part.card_id ? `[Interactive card: ${part.card_id}]` : "[Interactive card]");
        break;
      case "card_action":
        push(`[Card interaction: card=${part.card_id || ""} action=${part.action_id || ""} data=${part.data_json || ""}]`);
        break;
      case "contact": {
        const meta = part.metadata || {};
        const username = (meta.contact_username || "").trim();
        if (!username) break;
        const displayName = (meta.contact_display_name || "").trim();
        const role = (meta.contact_member_type || "").trim() === "agent" ? "agent" : "user";
        push(`[Shared contact: ${displayName || username} (@${username}, ${role})]`);
        break;
      }
      case "reaction": {
        const emoji = (part.reaction || "").trim();
        if (!emoji) break;
        const removed = (part.reaction_operation || "").trim().toLowerCase() === "removed";
        const quote = truncateReactionQuote(replyPreview);
        if (quote) {
          push(removed
            ? `[reaction ${emoji} removed from message: "${quote}"]`
            : `[reaction ${emoji} received on message: "${quote}"]`);
        } else {
          const target = shortMessageId(message.reply_to_message_id);
          if (removed) {
            push(target ? `[removed reaction ${emoji} from #${target}]` : `[removed reaction ${emoji}]`);
          } else {
            push(target ? `[reacted ${emoji} to #${target}]` : `[reacted ${emoji}]`);
          }
        }
        break;
      }
      case "live_call": {
        const summary = (part.summary_text || "").trim();
        const actionItems = Array.isArray(part.action_items) ? part.action_items.map((item: string) => item.trim()).filter(Boolean) : [];
        const followUps = Array.isArray(part.follow_ups) ? part.follow_ups.map((item: string) => item.trim()).filter(Boolean) : [];
        if (!summary && actionItems.length === 0 && followUps.length === 0) break;
        const lines = [`[Voice call summary (call_id=${(part.call_id || "").trim()}, end_reason=${(part.end_reason || "").trim()})]`];
        if (summary) lines.push(summary);
        if (actionItems.length > 0) lines.push(`Action items:\n${actionItems.map((item) => `- ${item}`).join("\n")}`);
        if (followUps.length > 0) lines.push(`Follow-ups:\n${followUps.map((item) => `- ${item}`).join("\n")}`);
        push(lines.join("\n"));
        break;
      }
      case "image": {
        const caption = (part.metadata?.caption || "").trim();
        push(caption ? `[Image attachment: ${caption}]` : "[Image attachment]");
        break;
      }
      case "file": {
        const filename = (part.filename || "").trim();
        const caption = (part.metadata?.caption || "").trim();
        push(caption ? `[File attachment: ${filename || "attachment"} — ${caption}]` : `[File attachment: ${filename || "attachment"}]`);
        break;
      }
    }
  }

  return parts.join(" ").trim();
};

const buildMessageContextHeader = (turn: Omit<ObservedTurn, "text">) => {
  const lines = [
    "[message_context]",
    `- sender: ${turn.senderUsername}`,
    "- sender_role: user",
    `- message_id: ${turn.messageId}`,
    `- conversation_id: ${turn.conversationId}`,
  ];

  if (turn.replyToMessageId) {
    lines.push(`- reply_to_message_id: ${turn.replyToMessageId}`);
  }

  return lines.join("\n");
};

const buildChatTurnPrompt = (turn: ObservedTurn) =>
  [buildMessageContextHeader(turn), "", turn.text].join("\n");

const normalizeOutputText = (value: string) => {
  const trimmed = (value || "").trim();
  const lowered = trimmed.toLowerCase();
  if (!trimmed) return "";
  if (lowered === "noop" || lowered === "noop.") return "";
  return trimmed;
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const trimRecentMessages = (messages: any[]) =>
  messages.length > MAX_RECENT_MESSAGES ? messages.slice(-MAX_RECENT_MESSAGES) : messages;

const appendRecentMessage = (state: SessionState | undefined, message: any) => {
  if (!state || !message || typeof message !== "object") return;
  state.recentMessages.push(cloneJson(message));
  state.recentMessages = trimRecentMessages(state.recentMessages);
};

const buildSyntheticBridgeMessage = (params: {
  conversationId: string;
  replyToMessageId?: string;
  senderUsername: string;
  text: string;
  metadata?: Record<string, string>;
}) => ({
  id: `claude-${generateId()}`,
  conversation_id: params.conversationId,
  reply_to_message_id: params.replyToMessageId || "",
  from: {
    username: params.senderUsername,
  },
  text: params.text,
  metadata: params.metadata || {},
});

const applyVoiceLanguage = (voiceName: string, language: string) => {
  const trimmedVoice = voiceName.trim();
  const trimmedLanguage = language.trim();
  if (!trimmedVoice || !trimmedLanguage) {
    return trimmedVoice;
  }

  const languageParts = trimmedLanguage.split("-");
  if (languageParts.length < 2) {
    return trimmedVoice;
  }

  const voiceParts = trimmedVoice.split("-");
  if (voiceParts.length < 4) {
    return trimmedVoice;
  }

  return `${languageParts[0]}-${languageParts[1]}-${voiceParts.slice(2).join("-")}`;
};

const buildCardJson = (components: any[], data?: Record<string, unknown>, cardId?: string) => {
  let rootId = components[0]?.id || "root";
  for (const component of components) {
    if (!component.parentId && !component.parent_id) {
      rootId = component.id;
      break;
    }
  }

  const lines = [
    JSON.stringify({
      surfaceUpdate: {
        surfaceId: "main",
        components,
        clearBefore: true,
      },
    }),
  ];

  if (data) {
    const contents = Object.keys(data).map((key) => ({
      key,
      valueString: typeof data[key] === "object" ? JSON.stringify(data[key]) : String(data[key]),
    }));
    lines.push(JSON.stringify({
      dataModelUpdate: {
        surfaceId: "main",
        contents,
      },
    }));
  }

  lines.push(JSON.stringify({
    beginRendering: {
      surfaceId: "main",
      root: rootId,
    },
  }));

  return {
    json_data: lines.join("\n"),
    version: "0.8",
    card_id: cardId || `claude-card-${generateId()}`,
  };
};

// In bridge mode the Mutiro host writes slog JSON records to stderr. Parse
// each line and render a compact `host: <msg> key=val ...` form.
const HOST_ATTR_DROP = new Set(["time", "level", "msg", "component", "agent_username"]);

const formatHostAttrValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const normalizeHostLogLine = (raw: string): { level: "info" | "warn" | "error"; text: string } => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed.msg === "string") {
        const rawLevel = typeof parsed.level === "string" ? parsed.level.toLowerCase() : "info";
        const level = rawLevel === "error" ? "error" : rawLevel === "warn" || rawLevel === "warning" ? "warn" : "info";
        const attrs = Object.entries(parsed)
          .filter(([key]) => !HOST_ATTR_DROP.has(key))
          .map(([key, value]) => `${key}=${formatHostAttrValue(value)}`)
          .filter((entry) => entry.length > 2);
        const detail = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
        return { level, text: `host: ${parsed.msg}${detail}` };
      }
    } catch {
      // fall through to raw passthrough
    }
  }
  return { level: "info", text: `host: ${trimmed}` };
};

const createHostProcess = (targetDir: string) => {
  const hostProcess = spawn("mutiro", ["agent", "host", "--mode=bridge"], {
    cwd: targetDir,
    env: process.env,
  });

  const stderrReader = readline.createInterface({
    input: hostProcess.stderr,
    terminal: false,
  });
  stderrReader.on("line", (line) => {
    if (!line.trim()) return;
    const { level, text } = normalizeHostLogLine(line);
    if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
  });

  hostProcess.on("exit", (code) => {
    stderrReader.close();
    console.log(`[Bridge] Mutiro host exited with code ${code}`);
    process.exit(code || 0);
  });

  return hostProcess;
};

const createBridgeClient = (hostProcess: ChildProcessWithoutNullStreams) => {
  // Bridge requests are ordinary NDJSON envelopes with request/response
  // correlation on request_id. Visible chat replies are *not* the response to
  // message.observed; they are separate outbound bridge requests.
  const pendingRequests = new Map<string, PendingRequest>();

  const send = (type: string, payload: any, extras: BridgeExtras = {}) => {
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      type,
      request_id: extras.request_id || generateId(),
      payload,
      ...extras,
    };
    hostProcess.stdin.write(`${JSON.stringify(envelope)}\n`);
  };

  const request = (type: string, payload: any, extras: BridgeExtras = {}) =>
    new Promise<any>((resolve, reject) => {
      const requestId = generateId();
      pendingRequests.set(requestId, { resolve, reject });
      send(type, payload, { ...extras, request_id: requestId });
    });

  const ack = (requestId: string, payloadType: string) => {
    send("command_result", {
      "@type": TYPE_URLS.bridgeCommandResult,
      ok: true,
      response: { "@type": payloadType },
    }, { request_id: requestId });
  };

  const resolveResponse = (requestId: string | undefined, payload: any) => {
    if (!requestId || !pendingRequests.has(requestId)) return false;
    pendingRequests.get(requestId)!.resolve(payload?.response || payload);
    pendingRequests.delete(requestId);
    return true;
  };

  const rejectResponse = (requestId: string | undefined, error: any) => {
    if (!requestId || !pendingRequests.has(requestId)) return false;
    pendingRequests.get(requestId)!.reject(error);
    pendingRequests.delete(requestId);
    return true;
  };

  const sendError = (requestId: string | undefined, code: string, message: string, extras: BridgeExtras = {}) => {
    if (!requestId) return;
    const envelope = {
      protocol_version: PROTOCOL_VERSION,
      type: "error",
      request_id: requestId,
      error: {
        code,
        message,
      },
      ...extras,
    };
    hostProcess.stdin.write(`${JSON.stringify(envelope)}\n`);
  };

  return {
    ack,
    rejectResponse,
    request,
    resolveResponse,
    send,
    sendError,
  };
};

const createMutiroMcpServer = (deps: {
  conversationId: string;
  requestHost: ReturnType<typeof createBridgeClient>["request"];
  state: SessionState;
}) => {
  // MCP tools here are thin adapters that translate Claude tool calls into
  // portable chatbridge operations. The host (not the brain) owns the
  // backend connection.
  const replyTarget = (explicitReplyTo?: string) => explicitReplyTo || deps.state.currentMessageId;

  const sendMessageTool = tool(
    "send_message",
    "Send a text message to the current Mutiro conversation. Use this when you want to send an explicit message or follow-up; your assistant reply text is already sent automatically at the end of the turn.",
    {
      message: z.string().describe("Text to send immediately to the user."),
      reply_to_message_id: z.string().optional().describe("Optional thread target. Defaults to the current user message."),
    },
    async (args) => {
      const normalizedMessage = normalizeOutputText(args.message);
      if (!normalizedMessage) {
        return toolTextResult("NOOP acknowledged. No message sent.");
      }
      const res = await deps.requestHost("message.send", {
        "@type": TYPE_URLS.bridgeSendMessageCommand,
        conversation_id: deps.conversationId,
        reply_to_message_id: replyTarget(args.reply_to_message_id),
        text: { text: normalizedMessage },
      });
      deps.state.sendMessageInvoked = true;
      return toolTextResult(`Message sent successfully: ${JSON.stringify(res, null, 2)}`);
    },
  );

  const sendVoiceMessageTool = tool(
    "send_voice_message",
    "Send a text-to-speech voice message to a Mutiro user.",
    {
      username: z.string().describe("Target username."),
      speech: z.string().describe("Speakable plain text to synthesize and send."),
      language: z.string().optional().describe("Optional BCP-47 language code to retarget the default voice."),
      reply_to_message_id: z.string().optional().describe("Optional thread target. Defaults to the current user message."),
    },
    async (args) => {
      const normalizedSpeech = normalizeOutputText(args.speech);
      if (!normalizedSpeech) {
        return toolTextResult("NOOP acknowledged. No voice message sent.");
      }
      const defaultVoice = "en-US-Chirp3-HD-Orus";
      const voiceName = args.language ? applyVoiceLanguage(defaultVoice, args.language) : defaultVoice;
      const res = await deps.requestHost("message.send_voice", {
        "@type": TYPE_URLS.bridgeSendVoiceMessageCommand,
        to_username: String(args.username).replace(/^@/, ""),
        speech: normalizedSpeech,
        voice_name: voiceName,
        reply_to_message_id: replyTarget(args.reply_to_message_id),
      });
      return toolTextResult(`Voice message sent successfully: ${JSON.stringify(res, null, 2)}`);
    },
  );

  const sendCardTool = tool(
    "send_card",
    "Send an interactive A2UI card to the current Mutiro conversation.",
    {
      components: z.array(z.any()).describe("Array of A2UI component definitions."),
      data: z.record(z.any()).optional().describe("Optional data model object for card bindings."),
      card_id: z.string().optional().describe("Optional stable card id."),
      reply_to_message_id: z.string().optional().describe("Optional thread target. Defaults to the current user message."),
    },
    async (args) => {
      const res = await deps.requestHost("message.send", {
        "@type": TYPE_URLS.bridgeSendMessageCommand,
        conversation_id: deps.conversationId,
        reply_to_message_id: replyTarget(args.reply_to_message_id),
        parts: {
          parts: [
            {
              card: buildCardJson(args.components, args.data, args.card_id),
            },
          ],
        },
      });
      deps.state.sendMessageInvoked = true;
      return toolTextResult(`Card sent successfully: ${JSON.stringify(res, null, 2)}`);
    },
  );

  const reactToMessageTool = tool(
    "react_to_message",
    "Add an emoji reaction to an existing Mutiro message.",
    {
      message_id: z.string().describe("Exact message ID to react to."),
      emoji: z.string().describe("Emoji character (for example 👍)."),
    },
    async (args) => {
      try {
        const res = await deps.requestHost("message.react", {
          "@type": TYPE_URLS.addReactionRequest,
          message_id: args.message_id,
          emoji: args.emoji,
        }, { message_id: args.message_id });
        return toolTextResult(JSON.stringify(res, null, 2));
      } catch (err: any) {
        console.error("[Bridge] react_to_message failed:", inspect(err, { depth: null, colors: false }));
        throw new Error(`Failed to react: ${JSON.stringify(err)}`);
      }
    },
  );

  const sendFileMessageTool = tool(
    "send_file_message",
    "Upload a local file and send it to the current Mutiro conversation.",
    {
      file_path: z.string().describe("Absolute path to the file on disk."),
      caption: z.string().optional().describe("Optional caption for the file."),
      reply_to_message_id: z.string().optional().describe("Optional thread target. Defaults to the current user message."),
    },
    async (args) => {
      const uploadRes = await deps.requestHost("media.upload", {
        "@type": TYPE_URLS.bridgeMediaUploadCommand,
        local_path: args.file_path,
        filename: path.basename(args.file_path),
        mime_type: "application/octet-stream",
      });

      if (!uploadRes?.media) {
        throw new Error(`Failed to upload media: ${JSON.stringify(uploadRes)}`);
      }

      const res = await deps.requestHost("message.send", {
        "@type": TYPE_URLS.bridgeSendMessageCommand,
        conversation_id: deps.conversationId,
        reply_to_message_id: replyTarget(args.reply_to_message_id),
        parts: {
          parts: [{ file: uploadRes.media }],
        },
      });
      deps.state.sendMessageInvoked = true;
      return toolTextResult(`File uploaded and sent: ${JSON.stringify(res, null, 2)}`);
    },
  );

  const forwardMessageTool = tool(
    "forward_message",
    "Forward an existing message to another conversation or directly to a Mutiro user. Provide either target_conversation_id or to_username (not both).",
    {
      message_id: z.string().describe("ID of the message to forward."),
      target_conversation_id: z.string().optional().describe("ID of the destination conversation."),
      to_username: z.string().optional().describe("Destination Mutiro username (direct message)."),
      comment: z.string().optional().describe("Optional comment to include with the forward."),
    },
    async (args) => {
      const targetConversationId = (args.target_conversation_id || "").trim();
      const toUsername = (args.to_username || "").trim().replace(/^@/, "");
      if (!targetConversationId && !toUsername) {
        return toolTextResult("forward_message requires either target_conversation_id or to_username.");
      }
      if (targetConversationId && toUsername) {
        return toolTextResult("forward_message accepts only one of target_conversation_id or to_username, not both.");
      }
      const res = await deps.requestHost("message.forward", {
        "@type": TYPE_URLS.forwardMessageRequest,
        message_id: args.message_id,
        ...(targetConversationId ? { conversation_id: targetConversationId } : { to_username: toUsername }),
        comment: args.comment || "",
      });
      return toolTextResult(JSON.stringify(res, null, 2));
    },
  );

  const recallTool = tool(
    "recall",
    "Semantically search the current conversation history.",
    {
      query: z.string().describe("Search query string."),
      conversation_id: z.string().optional().describe("Optional conversation scope."),
      max_results: z.number().optional().describe("Optional maximum result count."),
    },
    async (args) => {
      const res = await deps.requestHost("recall.search", {
        "@type": TYPE_URLS.recallSearchRequest,
        query: args.query,
        conversation_id: args.conversation_id,
        limit: args.max_results,
      });
      return toolTextResult(JSON.stringify(res, null, 2));
    },
  );

  const recallGetTool = tool(
    "recall_get",
    "Open a recalled item from the current conversation history.",
    {
      entry_id: z.string().describe("Recall entry id."),
      conversation_id: z.string().optional().describe("Optional conversation scope."),
    },
    async (args) => {
      const res = await deps.requestHost("recall.get", {
        "@type": TYPE_URLS.recallGetRequest,
        entry_id: args.entry_id,
        conversation_id: args.conversation_id,
      });
      return toolTextResult(JSON.stringify(res, null, 2));
    },
  );

  return createSdkMcpServer({
    name: "mutiro",
    version: "1.0.0",
    tools: [
      sendMessageTool,
      sendVoiceMessageTool,
      sendCardTool,
      reactToMessageTool,
      sendFileMessageTool,
      forwardMessageTool,
      recallTool,
      recallGetTool,
    ],
  });
};

const MUTIRO_TOOL_ALLOWLIST = [
  "mcp__mutiro__send_message",
  "mcp__mutiro__send_voice_message",
  "mcp__mutiro__send_card",
  "mcp__mutiro__react_to_message",
  "mcp__mutiro__send_file_message",
  "mcp__mutiro__forward_message",
  "mcp__mutiro__recall",
  "mcp__mutiro__recall_get",
];

const SYSTEM_PROMPT_APPEND = `
You are a Mutiro agent running on top of the Claude Agent SDK. Every turn begins with a [message_context] header that includes the conversation_id, message_id, and sender.

Response conventions:
- Your plain-text assistant reply is automatically sent back to the user as a Mutiro message at the end of the turn.
- Use the mcp__mutiro__send_message tool when you need to send additional or targeted messages mid-turn (rarely needed).
- Use mcp__mutiro__react_to_message, mcp__mutiro__send_voice_message, mcp__mutiro__send_card, mcp__mutiro__send_file_message, mcp__mutiro__forward_message, mcp__mutiro__recall, and mcp__mutiro__recall_get for their named purposes.
- Reply "NOOP" if there is nothing useful to send.
- You have full access to Claude Code's built-in tools (Bash, Read, Edit, Grep, WebFetch, ...). Your working directory is the Mutiro agent directory — treat it as the agent's persistent workspace.
`.trim();

const readAllowedDirs = (agentDir: string): string[] => {
  const configPath = path.join(agentDir, ".mutiro-agent.yaml");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw) as any;
    const dirs = parsed?.agent?.allowed_dirs;
    if (!Array.isArray(dirs)) return [];
    return dirs
      .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
      .map((d) => path.resolve(d));
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.error(`[Bridge] Failed to read allowed_dirs from ${configPath}:`, err?.message || err);
    }
    return [];
  }
};

const createSessionStore = (deps: {
  agentDir: string;
  additionalDirectories: string[];
  requestHost: ReturnType<typeof createBridgeClient>["request"];
  sendSignal: (conversationId: string, replyToMessageId: string, signalType: string, detailText?: string) => void;
}) => {
  const activeSessions = new Map<string, SessionState>();

  const getOrCreateSession = (conversationId: string): SessionState => {
    if (activeSessions.has(conversationId)) {
      return activeSessions.get(conversationId)!;
    }

    console.log(`[Bridge] Initializing Claude session for conversation: ${conversationId}`);

    const state: SessionState = {
      claudeSessionId: undefined,
      outputText: "",
      currentMessageId: "",
      recentMessages: [],
      sendMessageInvoked: false,
    };

    activeSessions.set(conversationId, state);
    return state;
  };

  const getSession = (conversationId: string) => activeSessions.get(conversationId);

  const runTurn = async (conversationId: string, promptText: string, state: SessionState) => {
    state.outputText = "";
    state.sendMessageInvoked = false;

    const mcpServer = createMutiroMcpServer({
      conversationId,
      requestHost: deps.requestHost,
      state,
    });

    let typingSent = false;
    const sendTypingOnce = () => {
      if (typingSent) return;
      typingSent = true;
      deps.sendSignal(conversationId, state.currentMessageId, "SIGNAL_TYPE_TYPING", "Writing response...");
    };

    const q = query({
      prompt: promptText,
      options: {
        cwd: deps.agentDir,
        ...(deps.additionalDirectories.length > 0 ? { additionalDirectories: deps.additionalDirectories } : {}),
        mcpServers: {
          mutiro: mcpServer,
        },
        allowedTools: MUTIRO_TOOL_ALLOWLIST,
        permissionMode: "bypassPermissions",
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: SYSTEM_PROMPT_APPEND,
        },
        ...(state.claudeSessionId ? { resume: state.claudeSessionId } : {}),
      },
    });

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "system" && (msg as any).subtype === "init") {
        state.claudeSessionId = (msg as any).session_id;
        continue;
      }

      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            sendTypingOnce();
            state.outputText += block.text;
            process.stdout.write(block.text);
          } else if (block.type === "tool_use") {
            deps.sendSignal(conversationId, state.currentMessageId, "SIGNAL_TYPE_TOOL_RUNNING", String(block.name || ""));
          }
        }
        continue;
      }

      if (msg.type === "result") {
        const subtype = (msg as any).subtype;
        if (subtype && subtype !== "success") {
          console.error("[Bridge] Claude turn ended with non-success subtype:", subtype, inspect(msg, { depth: null, colors: false }));
        }
        continue;
      }
    }

    if (process.stdout.isTTY === false) process.stdout.write("\n");
    else process.stdout.write("\n");
  };

  return { getOrCreateSession, getSession, runTurn };
};

const buildObservedTurn = (envelope: any): ObservedTurn | null => {
  const conversationId = envelope.conversation_id || envelope.payload?.message?.conversation_id;
  const messageId = envelope.message_id || envelope.payload?.message?.id;
  let text = extractBridgeMessageText(envelope.payload?.message, envelope.payload?.reply_to_message_preview);
  const attachmentContext = (envelope.payload?.attachment_context || "").trim();
  if (attachmentContext) {
    text = text ? `${text}${attachmentContext}` : attachmentContext;
  }

  if (!conversationId || !messageId || !text) {
    return null;
  }

  return {
    conversationId,
    messageId,
    replyToMessageId:
      envelope.reply_to_message_id ||
      envelope.payload?.reply_to_message_id ||
      envelope.payload?.message?.reply_to_message_id,
    senderUsername: envelope.payload?.message?.from?.username || "unknown",
    text,
  };
};

const isSelfEventMessage = (envelope: any, agentUsername: string) => {
  const senderUsername = envelope.payload?.message?.from?.username;
  const selfUsername = (agentUsername || "").trim();
  return !senderUsername || (!!selfUsername && senderUsername === selfUsername);
};

async function main() {
  const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  console.log(`[Bridge] Starting Mutiro <-> Claude Agent SDK Bridge in: ${targetDir}`);

  const hostProcess = createHostProcess(targetDir);
  const bridge = createBridgeClient(hostProcess);
  const bridgeState = {
    agentUsername: "",
  };

  const sendSignal = (conversationId: string, replyToMessageId: string, signalType: string, detailText = "") => {
    if (!conversationId) return;
    bridge.send("signal.emit", {
      "@type": TYPE_URLS.sendSignalRequest,
      conversation_id: conversationId,
      signal_type: signalType,
      detail_text: detailText,
      in_reply_to: replyToMessageId,
    }, {
      conversation_id: conversationId,
      reply_to_message_id: replyToMessageId,
    });
  };

  const sendReply = (conversationId: string, replyToMessageId: string, text: string, state?: SessionState) => {
    const normalizedText = normalizeOutputText(text);
    if (!normalizedText) return;
    appendRecentMessage(state, buildSyntheticBridgeMessage({
      conversationId,
      replyToMessageId,
      senderUsername: bridgeState.agentUsername || "assistant",
      text: normalizedText,
    }));
    bridge.send("message.send", {
      "@type": TYPE_URLS.bridgeSendMessageCommand,
      conversation_id: conversationId,
      reply_to_message_id: replyToMessageId,
      text: { text: normalizedText },
    }, {
      conversation_id: conversationId,
      reply_to_message_id: replyToMessageId,
    });
  };

  const endTurn = (conversationId: string, replyToMessageId: string) => {
    bridge.send("turn.end", {
      "@type": TYPE_URLS.bridgeTurnEndCommand,
      status: "completed",
    }, {
      conversation_id: conversationId,
      reply_to_message_id: replyToMessageId,
    });
  };

  const additionalDirectories = readAllowedDirs(targetDir);
  if (additionalDirectories.length > 0) {
    console.log(`[Bridge] Extending Claude sandbox with ${additionalDirectories.length} allowed_dirs: ${additionalDirectories.join(", ")}`);
  }

  const sessionStore = createSessionStore({
    agentDir: targetDir,
    additionalDirectories,
    requestHost: bridge.request,
    sendSignal,
  });

  const initializeBridge = async () => {
    // Standalone bridge handshake:
    // ready -> session.initialize -> subscription.set -> message.observed.
    console.log("[Bridge] Host ready, sending initialization...");
    await bridge.request("session.initialize", {
      "@type": TYPE_URLS.bridgeInitializeCommand,
      role: "brain",
      client_name: "claude-agents-bridge",
      client_version: "1.0.0",
      requested_optional_capabilities: OPTIONAL_CAPABILITIES,
    });

    console.log("[Bridge] Subscribing to event stream...");
    await bridge.request("subscription.set", {
      "@type": TYPE_URLS.bridgeSubscriptionSetCommand,
      all: true,
      conversation_ids: [],
    });
    console.log("[Bridge] Handshake complete. Listening for messages...");
  };

  const handleObservedMessage = async (envelope: any) => {
    if (envelope.type === "event.message" && isSelfEventMessage(envelope, bridgeState.agentUsername)) {
      return;
    }

    if (envelope.type === "message.observed") {
      bridge.ack(envelope.request_id, TYPE_URLS.bridgeMessageObservedResult);
    }

    const turn = buildObservedTurn(envelope);
    if (!turn) {
      if (envelope.conversation_id && envelope.message_id) {
        endTurn(envelope.conversation_id, envelope.message_id);
      }
      return;
    }

    const sessionState = sessionStore.getOrCreateSession(turn.conversationId);
    sessionState.currentMessageId = turn.messageId;
    appendRecentMessage(sessionState, envelope.payload?.message);

    sendSignal(turn.conversationId, turn.messageId, "SIGNAL_TYPE_THINKING", "Processing...");

    try {
      await sessionStore.runTurn(turn.conversationId, buildChatTurnPrompt(turn), sessionState);
    } catch (err) {
      console.error("[Bridge] Claude turn failed:", inspect(err, { depth: null, colors: false }));
    }

    // Send the assistant's accumulated text if the agent did not already
    // dispatch a visible message via the send_message tool mid-turn.
    if (!sessionState.sendMessageInvoked) {
      const replyText = normalizeOutputText(sessionState.outputText);
      if (replyText) {
        sendReply(turn.conversationId, turn.messageId, replyText, sessionState);
      }
    }

    endTurn(turn.conversationId, turn.messageId);
  };

  const handleTaskRequest = async (envelope: any) => {
    const conversationId = envelope.conversation_id || "task-queue";
    const sessionState = sessionStore.getOrCreateSession(conversationId);
    sessionState.currentMessageId = envelope.request_id;

    const taskText = envelope.payload?.prompt || envelope.payload?.text || envelope.payload?.description || "Execute pending tasks";

    sendSignal(conversationId, sessionState.currentMessageId, "SIGNAL_TYPE_THINKING", "Processing task...");

    try {
      await sessionStore.runTurn(conversationId, taskText, sessionState);
    } catch (err) {
      console.error("[Bridge] Claude task failed:", inspect(err, { depth: null, colors: false }));
    }

    // task.request returns plain text directly in the response payload instead
    // of using message.send, because this is delegated work rather than a
    // visible chat reply.
    bridge.send("command_result", {
      "@type": TYPE_URLS.bridgeCommandResult,
      ok: true,
      response: {
        "@type": TYPE_URLS.bridgeTaskResult,
        text: normalizeOutputText(sessionState.outputText),
      },
    }, {
      request_id: envelope.request_id,
      conversation_id: conversationId,
    });
  };

  const handleSessionSnapshot = (envelope: any) => {
    const conversationId = envelope.payload?.conversation_id || envelope.conversation_id;
    if (!conversationId) {
      bridge.sendError(envelope.request_id, "invalid_request", "session.snapshot conversation_id is required");
      return;
    }

    const sessionState = sessionStore.getSession(conversationId);
    bridge.send("command_result", {
      "@type": TYPE_URLS.bridgeCommandResult,
      ok: true,
      response: {
        "@type": TYPE_URLS.bridgeSessionSnapshotResult,
        recent_messages: sessionState?.recentMessages || [],
        metadata: {
          conversation_id: conversationId,
        },
      },
    }, {
      request_id: envelope.request_id,
      conversation_id: conversationId,
    });
  };

  const handleSessionObserved = async (envelope: any) => {
    const conversationId = envelope.payload?.conversation_id || envelope.conversation_id;
    if (!conversationId) {
      bridge.sendError(envelope.request_id, "invalid_request", "session.observed conversation_id is required");
      return;
    }

    const sessionState = sessionStore.getOrCreateSession(conversationId);
    const observedText = (envelope.payload?.text || "").trim();
    if (observedText) {
      appendRecentMessage(sessionState, buildSyntheticBridgeMessage({
        conversationId,
        senderUsername: "system",
        text: observedText,
        metadata: {
          source: (envelope.payload?.source || "").trim(),
        },
      }));
    }

    bridge.ack(envelope.request_id, TYPE_URLS.bridgeSessionObservedResult);
  };

  const rl = readline.createInterface({ input: hostProcess.stdout, terminal: false });

  rl.on("line", async (line) => {
    if (!line.trim()) return;

    try {
      const envelope = JSON.parse(line);

      switch (envelope.type) {
        case "ready":
          bridgeState.agentUsername = envelope.payload?.agent_username || bridgeState.agentUsername;
          try {
            await initializeBridge();
          } catch (err) {
            console.error("[Bridge] Handshake failed:", err);
          }
          break;

        case "command_result":
          bridge.resolveResponse(envelope.request_id, envelope.payload);
          break;

        case "error":
          if (!bridge.rejectResponse(envelope.request_id, envelope.error)) {
            console.error("[Bridge] Host error:", envelope.error);
          }
          break;

        case "message.observed":
        case "event.message":
          await handleObservedMessage(envelope);
          break;

        case "task.request":
          await handleTaskRequest(envelope);
          break;

        case "session.snapshot":
          handleSessionSnapshot(envelope);
          break;

        case "session.observed":
          await handleSessionObserved(envelope);
          break;

        default:
          if (envelope.request_id) {
            bridge.sendError(envelope.request_id, "unsupported_envelope", `unsupported envelope type ${JSON.stringify(envelope.type)}`, {
              conversation_id: envelope.conversation_id,
              message_id: envelope.message_id,
              reply_to_message_id: envelope.reply_to_message_id,
            });
          }
          break;
      }
    } catch (err) {
      console.error("[Bridge] Error processing line:", err);
    }
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
