# opencode-agents

Let OpenCode 2 agents spawn other agents and talk to them, as peers.

OpenCode's built-in `subagent` tool runs one task and returns its result. This plugin is different: each agent it spawns is a full, ordinary top-level session. It shows up in your session history, you can open it and talk to it yourself, and any session can message it by name. There is no tree of parents and children: agents are peers that send each other messages.

## Install

Add the plugin to `~/.config/opencode/opencode.jsonc`, by absolute path while it lives on disk:

```jsonc
{
  "plugins": [
    "/path/to/opencode-agents"
  ]
}
```

## Tools

The tools live in OpenCode's Code Mode under the `agents` namespace, so they cost no space in the tool list: agents call them inside `execute` as `tools.agents.spawn(...)`, `tools.agents.send(...)`, and so on. Set the `codemode` option to `false` to list them as direct tools named `agents_spawn`, `agents_send`, … instead. Messages and results always name the calls that match.

| Tool | What it does |
|---|---|
| `spawn` | Start an agent in a new top-level session and send it a first message (`prompt`, `file`, or both). Optional `name`, `agent`, `model` (`provider/model`), `directory`. Returns at once |
| `send` | Message an agent by name, or any session by ID (`message`, `file`, or both). Returns at once. `delivery: "queue"` waits for a busy receiver to finish its current turn instead of steering it |
| `read` | Show whether an agent is working, idle, or failed, with its latest reply or its last `messages` messages |
| `list` | List agents in this project with their status; `scope: "global"` lists every project |
| `stop` | Interrupt an agent this session spawned; `remove: true` also deletes its session |

For example:

> Spawn a `plan` agent named "reviewer" on anthropic/claude-sonnet-5-5 to review src/auth and send me its findings, and an `explore` agent named "mapper" to map the test suite and send its map to the reviewer.

### Messages

Nothing waits. A send delivers the message and returns; the receiver works on it in its own session. Every message starts with a short preamble naming the sender and its session ID, so the receiver knows another agent wrote it rather than the user, and answers by calling `send` back; the preamble names the exact call. That reply arrives in the sender's session as a new message and wakes it. The preamble also tells agents not to reply just to acknowledge, so two agents do not thank each other forever.

A message can be loaded from a text file with `file`, a path absolute or relative to the sender's directory, such as a plan or task brief. With text as well, the text comes first, then the file. Files over 256 KB are refused.

You can talk to any agent directly from the session list. Your messages there have no preamble, so the agent knows they are from you.

### Names

Names are unique within a project (the same name can exist in two projects). A name is looked up in the caller's project first, then across every project when exactly one agent has it. A session ID always works, and reaches any session, including ones you started yourself.

### Stopping

Any session can message any agent, but only the session that spawned an agent can stop or remove it. Removing deletes the session; it does not undo changes the agent made to files.

Agents get the normal permission rules for their agent and your config.

## Options

Pass options with the object form:

```jsonc
{
  "plugins": [
    { "package": "/path/to/opencode-agents", "options": { "codemode": false } }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `codemode` | `true` | Put the tools in Code Mode under `agents`; `false` lists them as direct tools |

## Chauffeur skill

The usage skill lives in [`skills/opencode-agents/SKILL.md`](skills/opencode-agents/SKILL.md). To let Chauffeur select it, add this source to the existing `sources` array in `~/.config/chauffeur/skill-sources.json`:

```json
{
  "id": "opencode-agents",
  "type": "git",
  "url": "https://github.com/StevenJPx2/opencode-agents.git",
  "ref": "master",
  "paths": ["skills/opencode-agents"]
}
```

Chauffeur never withholds the `agents` Code Mode namespace, and keeps the direct tools (`agents_spawn`, `agents_send`, `agents_read`, `agents_list`, `agents_stop`) in its base tool list for `codemode: false`. The skill explains using them; it does not authorize delegation that the user or project instructions prohibit.

## Development

```sh
bun install
bun run check   # typecheck and tests
```
