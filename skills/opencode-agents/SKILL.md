---
name: opencode-agents
description: Use when delegating work to OpenCode agents, running independent tasks in parallel, asking another agent for a review, or continuing a conversation with a spawned agent. Covers agents_spawn, agents_send, agents_read, agents_list, and agents_stop, background notifications, sibling messaging, and shared-file coordination.
---

# OpenCode agents

Use the `opencode-agents` plugin tools for named agents that keep their own conversation across tasks. Follow user and project restrictions on delegation; tool availability and this skill are not permission to delegate on their own.

## Start and continue a conversation

- `agents_spawn`: give a complete `prompt`, a short `name`, and optionally an `agent`, `model`, or `directory`. The new agent cannot see your conversation. Include the task, relevant paths, constraints, expected result, and how to verify it.
- Any configured agent can be used, including primary agents like `build` or `plan`. A model is `provider/model` or `provider/model#variant`; omit it to use the agent's model. Do not guess unavailable agent or model IDs.
- `directory` defaults to yours; relative paths resolve against your session directory. Agents share that working directory unless you select a different one; spawning does not create a worktree.
- `agents_send`: use `to` (the name or session ID) and `message` to ask a follow-up, correct course, or give another task in the same conversation. Reuse an agent when its existing context is useful instead of spawning a replacement.

Example tool inputs:

```json
{"name":"reviewer","agent":"plan","prompt":"Review src/auth for correctness. Do not edit files. Return prioritized findings with file paths and tests to add."}
```

```json
{"to":"reviewer","message":"Check whether the fix in src/auth/session.ts resolves your first finding."}
```

## Wait or work in parallel

- Spawn and send wait for a reply by default. Use `wait: false` for independent work while you continue elsewhere; the reply arrives later as a notification that wakes your session.
- `timeoutSeconds` bounds a foreground wait, not the agent's task. At the timeout (600 seconds by default), the wait becomes a background notification rather than failing.
- For a busy agent, `delivery: "steer"` (default) delivers at its next step. Use `delivery: "queue"` to wait until its current turn finishes before the next task is delivered.
- `agents_read` takes `from`; it shows status and the latest reply. `messages: 10` shows recent conversation, and `wait: true` waits for the current turn. Prefer notifications to repeated polling.
- `agents_list` lists your agents and, if you are a spawned agent, your siblings.

Assign non-overlapping files or separate worktrees to agents making concurrent edits. Keep read-only reviews explicit. Verify agents' findings and changed files before integrating them; their replies are reports, not proof that checks passed.

## Siblings, nesting, and cleanup

Spawned agents may spawn their own agents; the plugin has no agent-count or nesting-depth limit. Do not fan out recursively without a concrete need: each session consumes tokens and may make changes.

Spawned agents can send messages to siblings by name. Sibling sends always return immediately to avoid mutual waits; replies arrive as notifications. Only the session that spawned an agent can stop it.

- `agents_stop` with `name` interrupts an agent but preserves its context. Send another message to continue it later.
- `remove: true` also deletes its session and descendants. Use it only when that conversation is no longer needed; it does not undo filesystem changes.
- Stopping your session during a foreground wait interrupts the agent being waited on. A background agent can continue after your turn ends.

Agents are child sessions visible in OpenCode's session list, where the user can open and talk to them directly. Sessions inherit the parent's permission rules; never delegate an operation to bypass a denial or approval requirement.

If these tools are hidden, ask Chauffeur to reveal `agents_spawn`, `agents_send`, `agents_read`, `agents_list`, and `agents_stop`. With the plugin's `codemode: true` option, discover their exact paths using `search({ namespace: "agents" })` inside `execute`.
