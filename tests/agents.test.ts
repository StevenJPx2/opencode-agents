import { expect, test } from "bun:test"
import type { Message } from "../src/transcript.ts"
import { Agents, codeModeCall, directCall, MARKER_KEY, markerOf, parseModel, slug, uniqueName, type Call, type Delivery, type Host, type SessionInfo } from "../src/agents.ts"

const PROJECTS: Record<string, string> = { "/work": "prj_work", "/other": "prj_other" }

const say = (text: string) => ({ text })

/** An in-memory OpenCode. Sessions belong to the project of their directory; prompts are recorded, and `reply` answers one. */
function harness(files: Record<string, string> = {}, call: Call = directCall) {
  const sessions = new Map<string, SessionInfo>([
    ["ses_root", { id: "ses_root", projectID: "prj_work", title: "Fix the login bug", location: { directory: "/work" } }],
    ["ses_away", { id: "ses_away", projectID: "prj_other", title: "Elsewhere", location: { directory: "/other" } }],
  ])
  const messages = new Map<string, Message[]>()
  const prompts: Array<{ sessionID: string; text: string; delivery: Delivery; from: string }> = []
  const interrupted: string[] = []
  let next = 0

  const host: Host = {
    create: async (input) => {
      // Let concurrent spawns interleave, as real calls would.
      await new Promise((resolve) => setTimeout(resolve, 0))

      const id = `ses_${next++}`
      const info: SessionInfo = {
        id,
        projectID: PROJECTS[input.directory] ?? `prj_${input.directory}`,
        title: input.title,
        agent: input.agent,
        model: input.model,
        metadata: { [MARKER_KEY]: input.marker },
        location: { directory: input.directory },
      }

      sessions.set(id, info)

      return info
    },
    rename: async (sessionID, marker) => {
      const info = sessions.get(sessionID)!

      sessions.set(sessionID, { ...info, title: marker.name, metadata: { [MARKER_KEY]: marker } })
    },
    get: async (id) => sessions.get(id) ?? Promise.reject(new Error(`Session ${id} not found`)),
    sessions: async (projectID) => [...sessions.values()].filter((info) => projectID === undefined || info.projectID === projectID),
    prompt: async (input) => {
      prompts.push(input)
      messages.set(input.sessionID, [...(messages.get(input.sessionID) ?? []), { id: `m${next++}`, type: "user", text: input.text }])
    },
    context: async (sessionID) => messages.get(sessionID) ?? [],
    interrupt: async (sessionID) => {
      interrupted.push(sessionID)
    },
    remove: async (sessionID) => {
      sessions.delete(sessionID)
    },
    readText: async (path) => files[path] ?? Promise.reject(new Error("ENOENT: no such file or directory")),
  }

  const reply = (sessionID: string, text: string) => {
    messages.get(sessionID)?.push({ id: `a${next++}`, type: "assistant", content: [{ type: "text", text }] }, { id: `i${next++}`, type: "idle" })
  }
  const named = (name: string) => [...sessions.values()].find((info) => markerOf(info)?.name === name)!

  return { agents: new Agents(host, call), sessions, prompts, interrupted, reply, named }
}

test("spawn creates a top-level agent session and returns without waiting", async () => {
  const { agents, prompts, named } = harness()

  const out = await agents.spawn("ses_root", { prompt: say("map the repo"), agent: "explore", model: "anthropic/claude-haiku-5-5" })
  const agent = named("explore")

  expect(out).toContain('Spawned agent "explore" (explore, anthropic/claude-haiku-5-5')
  expect(out).toContain("messages you back with agents_send")
  expect(agent).not.toHaveProperty("parentID")
  expect(agent.metadata?.[MARKER_KEY]).toEqual({ name: "explore", spawnedBy: "ses_root" })
  expect(agent.location.directory).toBe("/work")
  expect(prompts).toEqual([{ sessionID: agent.id, text: expect.stringContaining("map the repo"), delivery: "steer", from: "ses_root" }])
})

test("every message names its sender and how to reply", async () => {
  const { agents, prompts, named } = harness()

  await agents.spawn("ses_root", { prompt: say("review src/auth"), name: "reviewer" })
  await agents.send(named("reviewer").id, { to: "ses_root", message: say("Found two issues."), delivery: "queue" })

  const [first, answer] = prompts
  const reviewer = named("reviewer").id

  expect(first?.text).toStartWith('[opencode-agents] This message is from session "Fix the login bug" (ses_root), not from the user.')
  expect(first?.text).toContain('calling agents_send with to: "ses_root"')
  expect(first?.text).toEndWith("\n\nreview src/auth")
  expect(answer).toEqual({ sessionID: "ses_root", text: expect.stringContaining(`agent "reviewer" (${reviewer})`), delivery: "queue", from: reviewer })
})

test("in Code Mode, messages and results name the Code Mode calls", async () => {
  const { agents, prompts } = harness({}, codeModeCall)

  expect(await agents.spawn("ses_root", { prompt: say("go"), name: "w" })).toContain("messages you back with tools.agents.send in execute")
  expect(prompts[0]?.text).toContain('calling tools.agents.send in execute with to: "ses_root"')
  await expect(agents.send("ses_root", { to: "nobody", message: say("hi"), delivery: "steer" })).rejects.toThrow('Call tools.agents.list in execute with scope: "global"')
})

test("a message can be loaded from a file, relative to the sender, after any text", async () => {
  const { agents, prompts } = harness({ "/work/plans/task.md": "# Task\n\nShip it.", "/abs/notes.md": "notes" })

  await agents.spawn("ses_root", { prompt: { file: "plans/task.md" }, name: "w" })
  await agents.send("ses_root", { to: "w", message: { text: "Also read these:", file: "/abs/notes.md" }, delivery: "steer" })

  expect(prompts[0]?.text).toEndWith("\n\n# Task\n\nShip it.")
  expect(prompts[1]?.text).toEndWith("\n\nAlso read these:\n\nnotes")
})

test("a missing message, file, or file content is an error and spawns nothing", async () => {
  const { agents, sessions } = harness({ "/work/empty.md": "  \n" })

  await expect(agents.spawn("ses_root", { prompt: {} })).rejects.toThrow("Give the message text, a file to load it from, or both.")
  await expect(agents.spawn("ses_root", { prompt: { file: "missing.md" } })).rejects.toThrow("Cannot read the message file /work/missing.md: ENOENT")
  await expect(agents.send("ses_root", { to: "ses_away", message: { file: "empty.md" }, delivery: "steer" })).rejects.toThrow("The message file /work/empty.md is empty.")
  expect(sessions.size).toBe(2)
})

test("names are unique within a project but may repeat across projects", async () => {
  const { agents, sessions } = harness()

  await agents.spawn("ses_root", { prompt: say("a"), agent: "build" })
  await agents.spawn("ses_root", { prompt: say("b"), agent: "build" })
  await agents.spawn("ses_root", { prompt: say("c"), agent: "build", directory: "../other" })

  const names = [...sessions.values()].flatMap((info) => {
    const marker = markerOf(info)

    return marker ? [`${info.projectID}:${marker.name}:${info.title}`] : []
  })

  expect(names).toEqual(["prj_work:build:build", "prj_work:build-2:build-2", "prj_other:build:build"])
})

test("concurrent spawns of one name still get distinct names", async () => {
  const { agents, sessions } = harness()

  await Promise.all([1, 2, 3].map((index) => agents.spawn("ses_root", { prompt: say(`task ${index}`), name: "worker" })))

  expect([...sessions.values()].flatMap((info) => markerOf(info)?.name ?? []).sort()).toEqual(["worker", "worker-2", "worker-3"])
})

test("a name resolves in this project first, then in a single other project", async () => {
  const { agents, prompts, named } = harness()

  await agents.spawn("ses_away", { prompt: say("a"), name: "remote" })
  await agents.send("ses_root", { to: "Remote", message: say("hello"), delivery: "steer" })

  expect(prompts.at(-1)?.sessionID).toBe(named("remote").id)

  await agents.spawn("ses_root", { prompt: say("b"), name: "remote" })
  await agents.send("ses_root", { to: "remote", message: say("hi"), delivery: "steer" })

  expect(prompts.at(-1)?.sessionID).not.toBe(named("remote").id)
})

test("an ambiguous or unknown name is an error that says what to do", async () => {
  const { agents } = harness()

  await agents.spawn("ses_root", { prompt: say("a"), name: "twin" })

  await expect(agents.send("ses_0", { to: "nobody", message: say("hi"), delivery: "steer" })).rejects.toThrow('Agents in this project: "twin"')

  await agents.spawn("ses_away", { prompt: say("b"), name: "solo" })
  await agents.spawn("ses_away", { prompt: say("c"), directory: "/elsewhere", name: "solo" })

  await expect(agents.send("ses_root", { to: "solo", message: say("hi"), delivery: "steer" })).rejects.toThrow("Address one by its session ID")
})

test("any session can be messaged by ID, but not the caller itself", async () => {
  const { agents, prompts } = harness()

  expect(await agents.send("ses_root", { to: "ses_away", message: say("hello"), delivery: "steer" })).toContain('Sent to session "Elsewhere" (ses_away)')
  expect(prompts.at(-1)?.sessionID).toBe("ses_away")
  await expect(agents.send("ses_root", { to: "ses_root", message: say("me"), delivery: "steer" })).rejects.toThrow("That is this session")
  await expect(agents.send("ses_root", { to: "ses_missing", message: say("?"), delivery: "steer" })).rejects.toThrow("No session ses_missing exists.")
})

test("read reports status and the latest reply, or a transcript, without waiting", async () => {
  const { agents, reply, named } = harness()

  await agents.spawn("ses_root", { prompt: say("hi"), name: "w" })

  expect(await agents.read("ses_root", { from: "w", messages: 0 })).toContain("is working.")

  reply(named("w").id, "done: 3 files")

  expect(await agents.read("ses_root", { from: "w", messages: 0 })).toEndWith("is idle. Its latest reply:\n\ndone: 3 files")
  expect(await agents.read("ses_root", { from: "w", messages: 5 })).toContain("assistant: done: 3 files")
})

test("list covers this project by default and every project when global", async () => {
  const { agents, reply, named } = harness()

  await agents.spawn("ses_root", { prompt: say("a"), name: "mine" })
  await agents.spawn("ses_away", { prompt: say("b"), name: "theirs" })
  reply(named("mine").id, "ok")

  const project = await agents.list("ses_root", "project")

  expect(project).toContain('"mine"')
  expect(project).toContain("idle, spawned by you")
  expect(project).not.toContain('"theirs"')

  const global = await agents.list("ses_root", "global")

  expect(global).toContain('"theirs"')
  expect(global).toContain("running, in /other")
  expect(await agents.list(named("mine").id, "project")).toContain("this session")
  expect(await harness().agents.list("ses_root", "project")).toContain('Use scope: "global"')
})

test("only the session that spawned an agent can stop or remove it", async () => {
  const { agents, sessions, interrupted, named } = harness()

  await agents.spawn("ses_root", { prompt: say("a"), name: "alice" })
  await agents.spawn("ses_root", { prompt: say("b"), name: "bob" })

  const bob = named("bob")

  await expect(agents.stop(named("alice").id, { name: "bob", remove: true })).rejects.toThrow("Only the session that spawned an agent")
  await expect(agents.stop("ses_root", { name: "ses_away", remove: false })).rejects.toThrow("was not spawned by this session")

  expect(await agents.stop("ses_root", { name: "bob", remove: false })).toContain("Interrupted")
  expect(interrupted).toEqual([bob.id])
  expect(await agents.stop("ses_root", { name: bob.id, remove: true })).toContain("Removed")
  expect(sessions.has(bob.id)).toBe(false)
})

test("names are slugs that can never be mistaken for session IDs", () => {
  expect(slug("My Agent!")).toBe("my-agent")
  expect(slug("ses_trick")).toBe("agent-ses_trick")
  expect(uniqueName("My Agent!", ["my-agent"])).toBe("my-agent-2")
})

test("models parse as provider/model with an optional variant", () => {
  expect(parseModel("anthropic/claude-sonnet-5-5")).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })
  expect(parseModel("huggingface/deepseek-ai/DeepSeek#high")).toEqual({ providerID: "huggingface", id: "deepseek-ai/DeepSeek", variant: "high" })
  expect(() => parseModel("sonnet")).toThrow("provider/model")
})
