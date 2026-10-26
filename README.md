# opencode-agents

Spawn OpenCode 2 agents as their own sessions and hold conversations with them.

OpenCode's built-in `subagent` tool runs one task in a subagent-mode agent and returns its result. This plugin keeps the agents around as named teammates: you can send follow-up messages that build on what they already know, run several at once in the background, and use any agent (including primary agents like `build` and `plan`) on any model or in another directory.

Each agent is a child session of the one that spawned it, so you can also open it from the session list and talk to it yourself.

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

| Tool | What it does |
|---|---|
| `agents_spawn` | Start an agent with a first task. Optional `name`, `agent`, `model` (`provider/model`), `directory`, `wait`, `timeoutSeconds` |
| `agents_send` | Send a message to an agent by name or session ID and, by default, wait for its reply. `delivery: "queue"` waits for a busy agent to finish its current turn instead of steering it |
| `agents_read` | Show an agent's status and latest reply, or its last `messages` messages. `wait: true` waits for the current turn |
| `agents_list` | List this session's agents and whether each is working, idle, or failed |
| `agents_stop` | Interrupt an agent; `remove: true` also deletes its session |

For example:

> Spawn a `plan` agent named "reviewer" on anthropic/claude-sonnet-5-5 to review src/auth, and an `explore` agent named "mapper" in the background to map the test suite. Then ask the reviewer to check its findings against the mapper's.

### Waiting and notifications

- `wait: false` returns at once. When the agent finishes, its reply arrives in your session as a notification that wakes the agent there.
- A wait that runs past its timeout (10 minutes by default) turns into the same background notification instead of failing.
- Stopping your session while it waits on an agent interrupts that agent too.

### Nesting and siblings

Spawned agents get the same tools. An agent can spawn its own agents and message its siblings by name. The plugin imposes no limit on the number of agents or their nesting depth. Messages to siblings never wait, so two agents waiting on each other cannot deadlock; the reply comes back as a notification. Only the session that spawned an agent can stop it.

Spawned sessions inherit the permission rules of the session that created them.

## Options

Pass options with the object form:

```jsonc
{
  "plugins": [
    { "package": "/path/to/opencode-agents", "options": { "timeoutSeconds": 120 } }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `timeoutSeconds` | `600` | Default wait for a reply before it is delivered as a notification |
| `codemode` | `false` | Put the tools in Code Mode under `agents` instead of listing them directly |

## Chauffeur skill

The usage skill lives in [`skills/opencode-agents/SKILL.md`](skills/opencode-agents/SKILL.md). To let Chauffeur select it for delegation tasks, add this source to the existing `sources` array in `~/.config/chauffeur/skill-sources.json`:

```json
{
  "id": "opencode-agents",
  "type": "git",
  "url": "https://github.com/StevenJPx2/opencode-agents.git",
  "ref": "master",
  "paths": ["skills/opencode-agents"]
}
```

To keep the tools available, include `agents_spawn`, `agents_send`, `agents_read`, `agents_list`, and `agents_stop` in Chauffeur's `tool-exposure.json` `base` list, preserving its other entries. The skill explains using them; it does not authorize delegation that the user or project instructions prohibit.

## Development

```sh
bun install
bun run check   # typecheck and tests
```
