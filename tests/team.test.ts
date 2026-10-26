import { expect, test } from "bun:test"
import type { Message } from "../src/transcript.ts"
import { MARKER_KEY, parseModel, Team, uniqueName, type Host, type SessionInfo } from "../src/team.ts"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** An in-memory OpenCode where each prompt is answered with "echo: <text>" once `finish` is called. */
function harness(options = { maxDepth: 2, maxAgents: 3, timeoutMs: 1_000 }) {
  const sessions = new Map<string, SessionInfo>([["ses_root", { id: "ses_root", location: { directory: "/work" } }]])
  const messages = new Map<string, Message[]>()
  const notes: Array<{ sessionID: string; text: string }> = []
  const idle = new Map<string, Array<() => void>>()
  const interrupted: string[] = []
  let manual = false
  let next = 0

  const finish = (sessionID: string) => {
    const log = messages.get(sessionID) ?? []
    const last = log.findLast((message) => message.type === "user")

    log.push({ id: `a${next++}`, type: "assistant", content: [{ type: "text", text: `echo: ${last?.text}` }] }, { id: `i${next++}`, type: "idle" })
    for (const resolve of idle.get(sessionID) ?? []) resolve()
    idle.delete(sessionID)
  }

  const host: Host = {
    create: async (input) => {
      const id = `ses_${next++}`
      const info: SessionInfo = {
        id,
        parentID: input.parentID,
        title: input.title,
        agent: input.agent,
        model: input.model,
        metadata: { [MARKER_KEY]: input.marker },
        location: { directory: input.directory },
      }

      sessions.set(id, info)
      messages.set(id, [])

      return info
    },
    get: async (id) => sessions.get(id) ?? Promise.reject(new Error(`no ${id}`)),
    children: async (parentID) => [...sessions.values()].filter((info) => info.parentID === parentID),
    prompt: async (sessionID, text) => {
      const id = `m${next++}`

      messages.get(sessionID)?.push({ id, type: "user", text })
      if (!manual) queueMicrotask(() => finish(sessionID))

      return id
    },
    wait: (sessionID, signal) =>
      new Promise((resolve, reject) => {
        const log = messages.get(sessionID) ?? []

        if (log.at(-1)?.type === "idle") return resolve()

        idle.set(sessionID, [...(idle.get(sessionID) ?? []), resolve])
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
    context: async (sessionID) => messages.get(sessionID) ?? [],
    interrupt: async (sessionID) => {
      interrupted.push(sessionID)
    },
    remove: async (sessionID) => {
      sessions.delete(sessionID)
    },
    notify: async (sessionID, text) => {
      notes.push({ sessionID, text })
    },
  }

  return {
    team: new Team(host, options),
    sessions,
    notes,
    interrupted,
    finish,
    hold: () => {
      manual = true
    },
  }
}

const never = new AbortController().signal

test("spawn creates a marked child session and returns its first reply", async () => {
  const { team, sessions } = harness()

  const out = await team.spawn("ses_root", { prompt: "map the repo", agent: "explore", model: "anthropic/claude-haiku-5-5", wait: true }, never)

  expect(out).toContain('Spawned agent "explore" (explore, anthropic/claude-haiku-5-5')
  expect(out).toContain("echo: map the repo")

  const child = [...sessions.values()].find((info) => info.parentID === "ses_root")

  expect(child?.metadata?.[MARKER_KEY]).toEqual({ name: "explore", depth: 1 })
  expect(child?.location.directory).toBe("/work")
})

test("follow-up messages go to the named agent and return its reply", async () => {
  const { team } = harness()

  await team.spawn("ses_root", { prompt: "hello", name: "Researcher", wait: true }, never)

  expect(await team.send("ses_root", { to: "researcher", message: "what next?", wait: true, delivery: "steer" }, never)).toContain("echo: what next?")
  await expect(team.send("ses_root", { to: "nobody", message: "hi", wait: true, delivery: "steer" }, never)).rejects.toThrow('Known agents: "researcher"')
})

test("names stay unique and relative directories resolve against the caller", async () => {
  const { team, sessions } = harness()

  await team.spawn("ses_root", { prompt: "a", agent: "build", wait: false }, never)
  await team.spawn("ses_root", { prompt: "b", agent: "build", directory: "sub/dir", wait: false }, never)

  const names = [...sessions.values()].map((info) => (info.metadata?.[MARKER_KEY] as { name: string } | undefined)?.name)

  expect(names).toEqual([undefined, "build", "build-2"])
  expect([...sessions.values()].at(-1)?.location.directory).toBe("/work/sub/dir")
  expect(uniqueName("My Agent!", ["my-agent"])).toBe("my-agent-2")
})

test("a background message notifies the sender when the reply arrives", async () => {
  const { team, notes, hold, finish, sessions } = harness()

  hold()

  const out = await team.spawn("ses_root", { prompt: "long job", name: "worker", wait: false }, never)

  expect(out).toContain("will arrive here as a notification")
  expect(notes).toEqual([])

  const worker = [...sessions.values()].find((info) => info.parentID === "ses_root")!

  finish(worker.id)
  await settle()
  await settle()

  expect(notes).toEqual([{ sessionID: "ses_root", text: expect.stringContaining("echo: long job") }])
})

test("a wait that times out hands over to a background notification", async () => {
  const { team, notes, hold, finish, sessions } = harness({ maxDepth: 2, maxAgents: 3, timeoutMs: 20 })

  hold()

  const out = await team.spawn("ses_root", { prompt: "slow", name: "slow", wait: true }, never)

  expect(out).toContain("still working")

  finish([...sessions.values()].find((info) => info.parentID === "ses_root")!.id)
  await settle()
  await settle()

  expect(notes).toHaveLength(1)
})

test("stopping the caller while it waits interrupts the agent", async () => {
  const { team, hold, interrupted } = harness()
  const controller = new AbortController()

  hold()

  const pending = team.spawn("ses_root", { prompt: "slow", name: "slow", wait: true }, controller.signal)

  await settle()
  controller.abort(new Error("stopped"))

  await expect(pending).rejects.toThrow("stopped")
  expect(interrupted).toHaveLength(1)
})

test("depth and count limits are enforced", async () => {
  const { team, sessions } = harness({ maxDepth: 1, maxAgents: 2, timeoutMs: 1_000 })

  await team.spawn("ses_root", { prompt: "a", wait: false }, never)
  await team.spawn("ses_root", { prompt: "b", wait: false }, never)
  await expect(team.spawn("ses_root", { prompt: "c", wait: false }, never)).rejects.toThrow("already has 2 agents")

  const child = [...sessions.values()].find((info) => info.parentID === "ses_root")!

  await expect(team.spawn(child.id, { prompt: "deeper", wait: false }, never)).rejects.toThrow("nest 1 level deep")
})

test("spawned agents can message siblings without waiting, but cannot stop them", async () => {
  const { team, sessions, notes } = harness()

  await team.spawn("ses_root", { prompt: "a", name: "alice", wait: true }, never)
  await team.spawn("ses_root", { prompt: "b", name: "bob", wait: true }, never)

  const alice = [...sessions.values()].find((info) => info.title === "alice")!

  expect(await team.list(alice.id)).toContain('"bob"')

  const out = await team.send(alice.id, { to: "bob", message: "status?", wait: true, delivery: "steer" }, never)

  expect(out).toContain("will arrive here as a notification")
  await settle()
  await settle()
  expect(notes).toEqual([{ sessionID: alice.id, text: expect.stringContaining("echo: status?") }])

  await expect(team.stop(alice.id, { name: "bob", remove: true })).rejects.toThrow("only that session can stop it")
})

test("read reports the latest reply or a transcript, and list shows status", async () => {
  const { team } = harness()

  await team.spawn("ses_root", { prompt: "hi", name: "w", wait: true }, never)

  expect(await team.read("ses_root", { from: "w", wait: false, messages: 0 }, never)).toContain("echo: hi")
  expect(await team.read("ses_root", { from: "w", wait: false, messages: 5 }, never)).toContain("user: hi")
  expect(await team.list("ses_root")).toContain(": idle")
  expect(await team.stop("ses_root", { name: "w", remove: true })).toContain("Removed")
  expect(await team.list("ses_root")).toBe("No agents have been spawned from this session.")
})

test("models parse as provider/model with an optional variant", () => {
  expect(parseModel("anthropic/claude-sonnet-5-5")).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })
  expect(parseModel("huggingface/deepseek-ai/DeepSeek#high")).toEqual({ providerID: "huggingface", id: "deepseek-ai/DeepSeek", variant: "high" })
  expect(() => parseModel("sonnet")).toThrow("provider/model")
})
