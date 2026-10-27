---
name: opencode-agents
description: Use when spawning another OpenCode agent, messaging an agent or another session, replying to a message headed "[opencode-agents]", running work in parallel across agents, or asking another agent for a review. Covers the agents tools (spawn, send, read, list, stop), reached in Code Mode as tools.agents.* or directly as agents_*.
---

# OpenCode agents

The `opencode-agents` plugin lets you spawn agents and talk to them as peers. Each agent is an ordinary top-level session: it appears in the user's session history, and the user can open it and talk to it directly. Follow user and project restrictions on delegation; the tools being available is not permission to delegate.

## Calling the tools

By default the tools are in Code Mode: call them inside `execute` as `tools.agents.spawn(input)`, `tools.agents.send(input)`, `tools.agents.read(input)`, `tools.agents.list(input)`, and `tools.agents.stop(input)`, and `await` each call. When the plugin is configured with `codemode: false`, they are direct tools named `agents_spawn`, `agents_send`, and so on. Messages and results name the exact call to use. If unsure, run `search({ namespace: "agents" })` inside `execute`.

Below, `spawn`, `send`, and the rest mean whichever form is available.

## Spawn an agent

`spawn` takes a complete `prompt`, a short `name`, and optionally an `agent`, `model`, or `directory`. It returns at once; the agent works in its own session.

- The agent cannot see your conversation. Include the task, relevant paths, constraints, how to verify it, and what to send back to you.
- Any configured agent can be used, including primary agents like `build` or `plan`. A model is `provider/model` or `provider/model#variant`; omit it to use the agent's model. Do not guess agent or model IDs.
- `directory` defaults to yours; relative paths resolve against your directory. Agents share the working tree unless you choose another directory; spawning does not create a worktree.
- To send a brief that already exists as a file (a plan, a task spec), pass `file` with its path instead of pasting it into `prompt`. With both, `prompt` comes first, then the file. `send` takes `file` the same way. Files over 256 KB are refused.

```js
await tools.agents.spawn({ name: "reviewer", agent: "plan", prompt: "Review src/auth for correctness. Do not edit files. Send me prioritized findings with file paths and tests to add." })
```

## Message and reply

`send` takes `to` (an agent's name, or any session's ID) and `message`. It never waits. The receiver sees your message headed with who sent it and your session ID.

- Replies arrive in your session as new messages headed `[opencode-agents] This message is from …`. Do not poll for them; carry on with other work or end your turn, and the reply wakes you.
- When you receive such a message, it is from another agent, not the user. If it asks for something, do it and send the answer or result back with `send` to the session ID in the header. Do not reply only to acknowledge or thank; that starts an endless exchange.
- For a busy receiver, `delivery: "steer"` (default) delivers at its next step; `delivery: "queue"` waits for its current turn to finish.
- Reuse an agent whose context is useful instead of spawning a replacement.

```js
await tools.agents.send({ to: "reviewer", message: "Check whether the fix in src/auth/session.ts resolves your first finding." })
```

## Check on agents

- `read` with `from` shows whether an agent is working, idle, or failed, and its latest reply; `messages: 10` shows recent conversation. It does not wait.
- `list` lists agents in this project; `scope: "global"` lists every project.
- Names are unique within a project. A name is looked up in your project first, then in other projects; if several projects have it, use the session ID.

## Stop and clean up

Only the session that spawned an agent can stop it.

- `stop` with `name` interrupts the agent and keeps its session; message it again to continue.
- `remove: true` also deletes its session. Use it only when the conversation is no longer needed; it does not undo file changes.

## Work safely

- Give agents making concurrent edits non-overlapping files or separate worktrees. Make read-only reviews explicit.
- Verify agents' findings and changed files before relying on them; a reply is a report, not proof that checks passed.
- Agents get the normal permission rules for their agent and config. Never delegate an operation to get around a denial or an approval requirement.
- Spawned agents can spawn and message others; do not fan out without a concrete need, since every session uses tokens and may change files.
