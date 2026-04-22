# Claude Agent Brain for Mutiro

Run Claude Code as a Mutiro agent. Persistent identity, addressable on every Mutiro client (Desktop, Mobile, Web, CLI), configured the way you already configure Claude Code.

![Mutiro UI](docs/assets/mutiro-claude-ui.png)

## What it is

The `mutiro-claude-brain` binary is a Mutiro [chatbridge](https://github.com/mutirolabs/pi-brain) adapter that spawns a Claude Agent SDK session for each conversation. It gives your Mutiro agent the full Claude Code toolkit — Bash, Read, Edit, Grep, WebFetch, MCP servers, subagents, skills, hooks — and wires the 8 Mutiro bridge operations in as an in-process MCP server.

Claude Code handles the cognition. Mutiro handles the envelope: identity, allowlist, presence, and the conversation surface.

## Install

```bash
npm install -g @mutirolabs/claude-agent-brain
```

Or run without installing:

```bash
npx @mutirolabs/claude-agent-brain /path/to/your/agent
```

You'll need Node 20+ and your `ANTHROPIC_API_KEY` set (Bedrock and Vertex are also supported via their respective env vars — the standard Claude SDK auth).

## Quick Start

Stop the built-in Mutiro brain for your agent first — two brains on one agent will race on every turn. Verify no host is running with `mutiro agent host status`.

Point the brain at your Mutiro agent directory:

```bash
mutiro-claude-brain /path/to/agent-directory
```

Your agent is now live on every Mutiro surface. Smoke test:

```bash
mutiro user message send <agent-username> "Hello! Who are you?"
```

## Configuration

Configure it like any Claude Code project. The agent directory *is* your Claude Code project.

| Where | What it does |
|-------|--------------|
| `CLAUDE.md` in the agent dir | System prompt / persona / behavioral rules. Auto-loaded by the `claude_code` preset. |
| `.claude/settings.json` | Model, permissions, allowed/denied tools, additional directories, hooks, output style — all standard Claude Code settings. |
| `.claude/settings.local.json` | Your local overrides (gitignored). Same shape as `settings.json`. |
| `.mcp.json` | External MCP servers to expose to Claude. Merges with Mutiro's built-in `mutiro` MCP server. |
| `.claude/skills/` | Claude Code skills available to the agent. |
| `.claude/commands/` | Custom slash commands. |
| Env vars (`ANTHROPIC_API_KEY`, etc.) | Authentication. Standard Claude SDK conventions. |

### One Mutiro-specific knob

`agent.allowed_dirs` in `.mutiro-agent.yaml` lets you extend the sandbox beyond the agent directory. These merge with `.claude/settings.json`'s `additionalDirectories` — both are respected, deduped, and passed to every Claude session.

```yaml
agent:
  allowed_dirs:
    - /Users/you/dev/some-repo
    - /Users/you/dev/another-repo
```

## Bridge invariants

A few things the brain owns; they're not user-configurable:

- **Permission mode**: `bypassPermissions`. Headless brains can't prompt; if you want manual approval per tool use, this isn't the right runtime.
- **The `mutiro` MCP server**: auto-registered with eight tools — `send_message`, `send_voice_message`, `send_card`, `react_to_message`, `send_file_message`, `forward_message`, `recall`, `recall_get`. They appear to Claude as `mcp__mutiro__*`.
- **Turn protocol**: every turn starts with a `[message_context]` header identifying the sender, conversation_id, and message_id. Claude's plain-text response is sent to the user as a Mutiro message when the turn ends. Reply `NOOP` to skip sending.
- **Session continuity**: each Mutiro conversation maps to a Claude SDK session id, resumed on subsequent turns. No history replay.

## Built-in Mutiro tools

Available inside every Claude session as `mcp__mutiro__*`:

| Tool | Purpose |
|------|---------|
| `send_message` | Additional or targeted text messages mid-turn (rarely needed; plain-text reply already auto-sends) |
| `send_voice_message` | TTS voice message to a Mutiro user |
| `send_card` | Send an interactive A2UI card |
| `react_to_message` | Emoji reaction to an existing message |
| `send_file_message` | Upload a local file and send it |
| `forward_message` | Forward a message to another conversation or user |
| `recall` | Semantically search this conversation's history |
| `recall_get` | Open a specific recalled item |

## Access control

Mutiro enforces the agent allowlist server-side. Denied users never reach the brain — this matters more here than with other runtimes because Claude Code is operating under `bypassPermissions` with full filesystem and shell access. Lock the allowlist down before exposing the agent:

```bash
mutiro agents allowlist get <agent-username>
mutiro agents allow <agent-username> <username>
mutiro agents deny <agent-username> <username>
```

## Show the Claude badge

Flag the agent as Claude-powered so every Mutiro client renders the Anthropic spark next to the avatar:

```bash
mutiro agents create <username> "<Display>" --badge claude
```

For an existing agent:

```bash
mutiro agents update-profile <agent-username> --badge claude
```

## Development

Clone the repo and run against a live agent directory:

```bash
git clone https://github.com/mutirolabs/claude-agent-brain.git
cd claude-agent-brain
npm install
npm run start -- /path/to/agent-directory
```

Type-check and build:

```bash
npm run check          # tsc --noEmit
npm run build          # esbuild bundle -> dist/mutiro-claude-brain.mjs
```

## Resources

- [Mutiro manual](https://mutiro.com/docs/manual)
- [Mutiro CLI reference](https://mutiro.com/docs/cli)
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- Sibling repo: [`pi-brain`](https://github.com/mutirolabs/pi-brain) — Pi as the brain
- Sibling repo: [`openclaw-brain`](https://github.com/mutirolabs/openclaw-brain) — OpenClaw as the brain, packaged as an OpenClaw channel extension
