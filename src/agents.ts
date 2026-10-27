import { isAbsolute, resolve } from "node:path"
import { latestTurn, statusOf, transcript, type Message, type Turn } from "./transcript.ts"

/** Session metadata key that marks a session as an agent, and prompt metadata key that names a message's sender. */
export const MARKER_KEY = "opencode-agents"

export type ModelRef = { readonly providerID: string; readonly id: string; readonly variant?: string }

export type SessionInfo = {
  readonly id: string
  readonly projectID: string
  readonly title?: string | undefined
  readonly agent?: string | undefined
  readonly model?: ModelRef | undefined
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
  readonly location: { readonly directory: string }
}

/** An agent's address within its project, and the one session allowed to stop or remove it. */
export type Marker = { readonly name: string; readonly spawnedBy: string }

export type Delivery = "steer" | "queue"

export type Scope = "project" | "global"

/** What the agents need from OpenCode; the plugin wires it to the session API. */
export interface Host {
  create(input: { title: string; agent?: string; model?: ModelRef; directory: string; marker: Marker }): Promise<SessionInfo>
  /** Gives a session a new name: its title and its marker. */
  rename(sessionID: string, marker: Marker): Promise<void>
  get(sessionID: string): Promise<SessionInfo>
  /** Every session in a project, or in every project when `projectID` is undefined. */
  sessions(projectID: string | undefined): Promise<ReadonlyArray<SessionInfo>>
  /** Delivers a message to a session, starting a turn when it is idle. */
  prompt(input: { sessionID: string; text: string; delivery: Delivery; from: string }): Promise<void>
  context(sessionID: string): Promise<ReadonlyArray<Message>>
  interrupt(sessionID: string): Promise<void>
  remove(sessionID: string): Promise<void>
  /** Reads a text file given by absolute path. */
  readText(path: string): Promise<string>
}

/** The text of a message: written out, loaded from a file, or both (text first). */
export type Body = { readonly text?: string | undefined; readonly file?: string | undefined }

export function markerOf(info: SessionInfo): Marker | undefined {
  const value = info.metadata?.[MARKER_KEY]

  if (typeof value !== "object" || value === null) return undefined

  const { name, spawnedBy } = value as Record<string, unknown>

  return typeof name === "string" && typeof spawnedBy === "string" ? { name, spawnedBy } : undefined
}

/** `provider/model` or `provider/model#variant`. */
export function parseModel(text: string): ModelRef {
  const [ref = "", variant] = text.trim().split("#", 2)
  const slash = ref.indexOf("/")

  if (slash <= 0 || slash === ref.length - 1) throw new Error(`Model "${text}" should look like provider/model, such as anthropic/claude-sonnet-5-5.`)

  const model = { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }

  return variant ? { ...model, variant } : model
}

const SESSION_ID = /^ses_/

/** A name never looks like a session ID, so either can be passed wherever an agent is addressed. */
export function slug(text: string): string {
  const name = text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent"

  return SESSION_ID.test(name) ? `agent-${name}` : name
}

export function uniqueName(wanted: string, taken: ReadonlyArray<string>): string {
  const base = slug(wanted)
  const used = new Set(taken.map((name) => name.toLowerCase()))

  if (!used.has(base)) return base

  for (let suffix = 2; ; suffix += 1) if (!used.has(`${base}-${suffix}`)) return `${base}-${suffix}`
}

export function describe(info: SessionInfo): string {
  const marker = markerOf(info)

  if (marker === undefined) return `session ${info.title ? `"${info.title}" ` : ""}(${info.id})`

  const parts = [info.agent, info.model ? `${info.model.providerID}/${info.model.id}` : undefined, info.id]

  return `agent "${marker.name}" (${parts.filter(Boolean).join(", ")})`
}

export type ToolName = "spawn" | "send" | "read" | "list" | "stop"

/** How a model calls one of these tools, for the hints in messages and results. */
export type Call = (tool: ToolName) => string

export const directCall: Call = (tool) => `agents_${tool}`

export const codeModeCall: Call = (tool) => `tools.agents.${tool} in execute`

/** Heads every message, so the receiver knows another agent wrote it and how to answer. */
export function preamble(sender: SessionInfo, call: Call): string {
  return [
    `[opencode-agents] This message is from ${describe(sender)}, not from the user.`,
    `When the sender asked for something, send your answer or result back by calling ${call("send")} with to: "${sender.id}" once it is ready. Do not reply only to acknowledge or thank.`,
  ].join("\n")
}

export function formatTurn(info: SessionInfo, turn: Turn): string {
  const heading =
    turn.status === "failed"
      ? `${describe(info)} stopped with an error: ${turn.error ?? "unknown error"}`
      : turn.status === "running"
        ? `${describe(info)} is working.`
        : `${describe(info)} is idle. Its latest reply${turn.toolCalls > 0 ? `, after ${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"}` : ""}:`

  if (turn.reply === "") return turn.status === "done" ? `${heading}\n\n(no text reply)` : heading

  return `${heading}\n\n${turn.reply}`
}

/** A path as given, or relative to the caller's directory. */
function within(caller: SessionInfo, path: string): string {
  return isAbsolute(path) ? path : resolve(caller.location.directory, path)
}

/** How many sessions' conversations are read at once when listing. */
const LIST_CONCURRENCY = 8

/**
 * Agents are ordinary top-level sessions any session can message. Calls are made
 * on behalf of a caller session, which only matters for naming the sender and for
 * stopping: an agent can be stopped or removed only by the session that spawned it.
 */
export class Agents {
  private naming: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly host: Host,
    private readonly call: Call,
  ) {}

  private async agents(projectID: string | undefined): Promise<SessionInfo[]> {
    return (await this.host.sessions(projectID)).filter((info) => markerOf(info) !== undefined)
  }

  /** A session ID reaches any session; a name is looked up in the caller's project, then in every project. */
  private async resolve(caller: SessionInfo, ref: string): Promise<SessionInfo> {
    const wanted = ref.trim()

    if (SESSION_ID.test(wanted)) return this.host.get(wanted)

    const named = (infos: ReadonlyArray<SessionInfo>) => infos.filter((info) => markerOf(info)?.name === wanted.toLowerCase())
    const local = await this.agents(caller.projectID)
    const [here] = named(local)

    if (here) return here

    const everywhere = named(await this.agents(undefined))

    if (everywhere.length === 1) return everywhere[0] as SessionInfo

    if (everywhere.length > 1) {
      const options = everywhere.map((info) => `${info.id} in ${info.location.directory}`).join("; ")

      throw new Error(`Several projects have an agent named "${wanted}": ${options}. Address one by its session ID.`)
    }

    const known = local.map((info) => `"${markerOf(info)?.name}"`).join(", ")

    throw new Error(`No agent named "${ref}". ${known ? `Agents in this project: ${known}.` : "This project has no agents."} Call ${this.call("list")} with scope: "global" to see every project.`)
  }

  /** Runs naming steps one at a time, so two spawns in this process cannot claim the same name. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.naming.then(work, work)

    this.naming = run.catch(() => {})

    return run
  }

  async spawn(
    callerID: string,
    input: {
      readonly prompt: Body
      readonly name?: string | undefined
      readonly agent?: string | undefined
      readonly model?: string | undefined
      readonly directory?: string | undefined
    },
  ): Promise<string> {
    const caller = await this.host.get(callerID)
    const model = input.model ? parseModel(input.model) : undefined
    const directory = input.directory ? within(caller, input.directory) : caller.location.directory
    const prompt = await this.compose(caller, input.prompt)
    const wanted = slug(input.name ?? input.agent ?? "agent")

    // The new session's project is known only once it exists, so it is named after it is created.
    const info = await this.exclusive(async () => {
      const created = await this.host.create({
        title: wanted,
        directory,
        marker: { name: wanted, spawnedBy: caller.id },
        ...(input.agent ? { agent: input.agent } : {}),
        ...(model ? { model } : {}),
      })
      const taken = (await this.agents(created.projectID)).flatMap((other) => (other.id === created.id ? [] : [markerOf(other)?.name ?? ""]))
      const name = uniqueName(wanted, taken)

      if (name === wanted) return created

      const marker = { name, spawnedBy: caller.id }

      await this.host.rename(created.id, marker)

      return { ...created, title: name, metadata: { ...created.metadata, [MARKER_KEY]: marker } }
    })

    await this.deliver(caller, info, prompt, "steer")

    return `Spawned ${describe(info)} in ${info.location.directory} and sent it your message. It works on its own and messages you back with ${this.call("send")}; that reply arrives here as a new message. Address it as "${markerOf(info)?.name}".`
  }

  async send(callerID: string, input: { readonly to: string; readonly message: Body; readonly delivery: Delivery }): Promise<string> {
    const caller = await this.host.get(callerID)
    const target = await this.resolve(caller, input.to)

    if (target.id === caller.id) throw new Error("That is this session. Message another session.")

    await this.deliver(caller, target, await this.compose(caller, input.message), input.delivery)

    return `Sent to ${describe(target)}. If it has something for you, it replies with ${this.call("send")} and the reply arrives here as a new message. Carry on meanwhile.`
  }

  async read(callerID: string, input: { readonly from: string; readonly messages: number }): Promise<string> {
    const caller = await this.host.get(callerID)
    const target = await this.resolve(caller, input.from)
    const messages = await this.host.context(target.id)
    const turn = latestTurn(messages)

    if (input.messages > 0) return `${formatTurn(target, { ...turn, reply: "" })}\n\n${transcript(messages, input.messages)}`

    return formatTurn(target, turn)
  }

  async list(callerID: string, scope: Scope): Promise<string> {
    const caller = await this.host.get(callerID)
    const agents = await this.agents(scope === "project" ? caller.projectID : undefined)

    if (agents.length === 0) return scope === "project" ? 'This project has no agents. Use scope: "global" to list every project.' : "There are no agents."

    const lines: string[] = []

    for (let start = 0; start < agents.length; start += LIST_CONCURRENCY) {
      const batch = agents.slice(start, start + LIST_CONCURRENCY).map(async (info) => {
        const status = await this.host.context(info.id).then(statusOf, () => "unknown")
        const notes = [
          info.id === caller.id ? "this session" : undefined,
          markerOf(info)?.spawnedBy === caller.id ? "spawned by you" : undefined,
          scope === "global" ? `in ${info.location.directory}` : undefined,
        ].filter(Boolean)

        return `- ${describe(info)}: ${[status, ...notes].join(", ")}`
      })

      lines.push(...(await Promise.all(batch)))
    }

    return lines.join("\n")
  }

  async stop(callerID: string, input: { readonly name: string; readonly remove: boolean }): Promise<string> {
    const caller = await this.host.get(callerID)
    const target = await this.resolve(caller, input.name)

    if (markerOf(target)?.spawnedBy !== caller.id) {
      throw new Error(`${describe(target)} was not spawned by this session. Only the session that spawned an agent can stop or remove it.`)
    }

    if (input.remove) {
      await this.host.remove(target.id)

      return `Removed ${describe(target)} and its session.`
    }

    await this.host.interrupt(target.id)

    return `Interrupted ${describe(target)}. Its session is kept; message it again to continue.`
  }

  private async compose(caller: SessionInfo, body: Body): Promise<string> {
    const file = body.file === undefined ? undefined : within(caller, body.file)
    const loaded = file === undefined ? undefined : await this.host.readText(file).catch((error: unknown) => {
      throw new Error(`Cannot read the message file ${file}: ${error instanceof Error ? error.message : String(error)}`)
    })
    const text = [body.text, loaded].filter((part) => part !== undefined && part.trim() !== "").join("\n\n")

    if (text === "") throw new Error(body.file === undefined ? "Give the message text, a file to load it from, or both." : `The message file ${file} is empty.`)

    return text
  }

  private deliver(sender: SessionInfo, target: SessionInfo, text: string, delivery: Delivery): Promise<void> {
    return this.host.prompt({ sessionID: target.id, text: `${preamble(sender, this.call)}\n\n${text}`, delivery, from: sender.id })
  }
}
