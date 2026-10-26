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

Spawned agents get the same tools. An agent can spawn its own agents up to `maxDepth` levels below the session you started, and can message its siblings by name. Messages to siblings never wait, so two agents waiting on each other cannot deadlock; the reply comes back as a notification. Only the session that spawned an agent can stop it.

Spawned sessions inherit the permission rules of the session that created them.

## Options

Pass options with the object form:

```jsonc
{
  "plugins": [
    { "package": "/path/to/opencode-agents", "options": { "maxAgents": 4 } }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `maxDepth` | `2` | Levels of spawned agents allowed below a session you started |
| `maxAgents` | `8` | Agents one session may have at once |
| `timeoutSeconds` | `600` | Default wait for a reply before it is delivered as a notification |
| `codemode` | `false` | Put the tools in Code Mode under `agents` instead of listing them directly |

## Development

```sh
bun install
bun run check   # typecheck and tests
```
