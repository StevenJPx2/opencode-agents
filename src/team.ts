import { isAbsolute, resolve } from "node:path"
import { statusOf, transcript, turnAfter, type Message, type Turn } from "./transcript.ts"

/** Session metadata key that marks a session as one this plugin spawned. */
export const MARKER_KEY = "opencode-agents"

export type ModelRef = { readonly providerID: string; readonly id: string; readonly variant?: string }

export type SessionInfo = {
  readonly id: string
  readonly parentID?: string | undefined
  readonly title?: string | undefined
  readonly agent?: string | undefined
  readonly model?: ModelRef | undefined
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
  readonly location: { readonly directory: string }
}

export type Marker = { readonly name: string; readonly depth: number }

export type Delivery = "steer" | "queue"

/** What the team needs from OpenCode; the plugin wires it to the session API. */
export interface Host {
  create(input: {
    parentID: string
    title: string
    agent?: string
    model?: ModelRef
    directory: string
    marker: Marker
  }): Promise<SessionInfo>
  get(sessionID: string): Promise<SessionInfo>
  children(parentID: string): Promise<ReadonlyArray<SessionInfo>>
  /** Sends a user message and returns its message ID. */
  prompt(sessionID: string, text: string, delivery: Delivery): Promise<string>
  /** Resolves once the session is idle. */
  wait(sessionID: string, signal: AbortSignal): Promise<void>
  context(sessionID: string): Promise<ReadonlyArray<Message>>
  interrupt(sessionID: string): Promise<void>
  remove(sessionID: string): Promise<void>
  /** Wakes `sessionID` with a message that is not from the user. */
  notify(sessionID: string, text: string, description: string): Promise<void>
}

export type TeamOptions = {
  /** How many levels of spawned agents may exist below a session the user started. */
  readonly maxDepth: number
  /** Agents one session may have spawned at once. */
  readonly maxAgents: number
  /** How long a call waits for a reply before handing the wait to a background watcher. */
  readonly timeoutMs: number
}

type Member = { readonly info: SessionInfo; readonly name: string; readonly relation: "child" | "sibling" }

export function markerOf(info: SessionInfo): Marker | undefined {
  const value = info.metadata?.[MARKER_KEY]

  if (typeof value !== "object" || value === null) return undefined

  const { name, depth } = value as Record<string, unknown>

  return typeof name === "string" && typeof depth === "number" ? { name, depth } : undefined
}

/** `provider/model` or `provider/model#variant`. */
export function parseModel(text: string): ModelRef {
  const [ref = "", variant] = text.trim().split("#", 2)
  const slash = ref.indexOf("/")

  if (slash <= 0 || slash === ref.length - 1) throw new Error(`Model "${text}" should look like provider/model, such as anthropic/claude-sonnet-5-5.`)

  const model = { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }

  return variant ? { ...model, variant } : model
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent"
}

export function uniqueName(wanted: string, taken: ReadonlyArray<string>): string {
  const base = slug(wanted)
  const used = new Set(taken.map((name) => name.toLowerCase()))

  if (!used.has(base)) return base

  for (let suffix = 2; ; suffix += 1) if (!used.has(`${base}-${suffix}`)) return `${base}-${suffix}`
}

const describe = (member: Member): string => {
  const parts = [member.info.agent, member.info.model ? `${member.info.model.providerID}/${member.info.model.id}` : undefined]

  return `"${member.name}" (${parts.filter(Boolean).join(", ") || "default agent"}, ${member.info.id})`
}

export function formatTurn(member: Member, turn: Turn): string {
  const heading =
    turn.status === "failed"
      ? `Agent ${describe(member)} stopped with an error: ${turn.error ?? "unknown error"}`
      : turn.status === "running"
        ? `Agent ${describe(member)} is still working.`
        : `Agent ${describe(member)} replied${turn.toolCalls > 0 ? ` after ${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"}` : ""}:`

  if (turn.reply === "") return turn.status === "done" ? `${heading}\n\n(no text reply)` : heading

  return `${heading}\n\n${turn.reply}`
}

const aborted = (signal: AbortSignal) => signal.aborted

/**
 * The agents a session has spawned, and the conversations with them. Calls are
 * made on behalf of a caller session: it can talk to the agents it spawned and,
 * when it is a spawned agent itself, to its siblings.
 */
export class Team {
  private readonly watchers = new Map<string, AbortController>()
  private readonly closed = new AbortController()

  constructor(private readonly host: Host, private readonly options: TeamOptions) {}

  /** Stops every background watcher. */
  close(): void {
    this.closed.abort()
  }

  private async members(caller: SessionInfo): Promise<Member[]> {
    const own = (await this.host.children(caller.id)).flatMap((info): Member[] => {
      const marker = markerOf(info)

      return marker ? [{ info, name: marker.name, relation: "child" }] : []
    })

    const callerMarker = markerOf(caller)

    if (callerMarker === undefined || caller.parentID === undefined) return own

    const siblings = (await this.host.children(caller.parentID)).flatMap((info): Member[] => {
      const marker = markerOf(info)

      return marker && info.id !== caller.id ? [{ info, name: marker.name, relation: "sibling" }] : []
    })

    return [...own, ...siblings]
  }

  private async find(caller: SessionInfo, ref: string): Promise<Member> {
    const members = await this.members(caller)
    const wanted = ref.trim().toLowerCase()
    const member = members.find((candidate) => candidate.info.id === ref.trim() || candidate.name.toLowerCase() === wanted)

    if (member) return member

    const known = members.map((candidate) => `"${candidate.name}"`).join(", ")

    throw new Error(`No agent named "${ref}". ${known ? `Known agents: ${known}.` : "No agents have been spawned from this session."}`)
  }

  async spawn(
    callerID: string,
    input: {
      readonly prompt: string
      readonly name?: string | undefined
      readonly agent?: string | undefined
      readonly model?: string | undefined
      readonly directory?: string | undefined
      readonly wait: boolean
      readonly timeoutMs?: number | undefined
    },
    signal: AbortSignal,
  ): Promise<string> {
    const caller = await this.host.get(callerID)
    const depth = (markerOf(caller)?.depth ?? 0) + 1

    if (depth > this.options.maxDepth) {
      throw new Error(`Spawned agents may nest ${this.options.maxDepth} level${this.options.maxDepth === 1 ? "" : "s"} deep; this session cannot spawn more. Do the work here or report back instead.`)
    }

    const existing = (await this.members(caller)).filter((member) => member.relation === "child")

    if (existing.length >= this.options.maxAgents) {
      throw new Error(`This session already has ${existing.length} agents, the most allowed. Close one with agents_stop (remove: true) first.`)
    }

    const name = uniqueName(input.name ?? input.agent ?? "agent", existing.map((member) => member.name))
    const model = input.model ? parseModel(input.model) : undefined
    const directory = input.directory
      ? isAbsolute(input.directory) ? input.directory : resolve(caller.location.directory, input.directory)
      : caller.location.directory

    const info = await this.host.create({
      parentID: caller.id,
      title: name,
      directory,
      marker: { name, depth },
      ...(input.agent ? { agent: input.agent } : {}),
      ...(model ? { model } : {}),
    })

    const member: Member = { info, name, relation: "child" }
    const reply = await this.converse(caller, member, input.prompt, { wait: input.wait, delivery: "steer", timeoutMs: input.timeoutMs }, signal)

    return `Spawned agent ${describe(member)}. Message it with agents_send using to: "${name}".\n\n${reply}`
  }

  async send(
    callerID: string,
    input: { readonly to: string; readonly message: string; readonly wait: boolean; readonly delivery: Delivery; readonly timeoutMs?: number | undefined },
    signal: AbortSignal,
  ): Promise<string> {
    const caller = await this.host.get(callerID)
    const member = await this.find(caller, input.to)
    // A sibling may be waiting on this caller already, so waiting here could deadlock both.
    const wait = input.wait && member.relation === "child"

    return this.converse(caller, member, input.message, { wait, delivery: input.delivery, timeoutMs: input.timeoutMs }, signal)
  }

  async read(
    callerID: string,
    input: { readonly from: string; readonly wait: boolean; readonly messages: number; readonly timeoutMs?: number | undefined },
    signal: AbortSignal,
  ): Promise<string> {
    const caller = await this.host.get(callerID)
    const member = await this.find(caller, input.from)
    let messages = await this.host.context(member.info.id)
    let turn = turnAfter(messages)

    if (input.wait && turn.status === "running") {
      const settled = await this.settle(member.info.id, undefined, input.timeoutMs ?? this.options.timeoutMs, signal)

      if (settled) {
        turn = settled
        messages = await this.host.context(member.info.id)
      }
    }

    if (turn.status !== "running") this.unwatch(member.info.id)

    if (input.messages > 0) return `${formatTurn(member, { ...turn, reply: "" })}\n\n${transcript(messages, input.messages)}`

    return formatTurn(member, turn)
  }

  async list(callerID: string): Promise<string> {
    const caller = await this.host.get(callerID)
    const members = await this.members(caller)

    if (members.length === 0) return "No agents have been spawned from this session."

    const lines = await Promise.all(
      members.map(async (member) => {
        const status = await this.host.context(member.info.id).then(statusOf, () => "unknown")
        const relation = member.relation === "sibling" ? ", sibling" : ""

        return `- ${describe(member)}: ${status}${relation}`
      }),
    )

    return lines.join("\n")
  }

  async stop(callerID: string, input: { readonly name: string; readonly remove: boolean }): Promise<string> {
    const caller = await this.host.get(callerID)
    const member = await this.find(caller, input.name)

    if (member.relation !== "child") throw new Error(`"${member.name}" was spawned by another session; only that session can stop it.`)

    this.unwatch(member.info.id)

    if (input.remove) {
      await this.host.remove(member.info.id)

      return `Removed agent ${describe(member)} and its session.`
    }

    await this.host.interrupt(member.info.id)

    return `Interrupted agent ${describe(member)}. Its session is kept; message it again to continue.`
  }

  private async converse(
    caller: SessionInfo,
    member: Member,
    text: string,
    input: { readonly wait: boolean; readonly delivery: Delivery; readonly timeoutMs?: number | undefined },
    signal: AbortSignal,
  ): Promise<string> {
    const messageID = await this.host.prompt(member.info.id, text, input.delivery)

    if (!input.wait) {
      this.watch(caller.id, member, messageID)

      return `Message sent to "${member.name}". Its reply will arrive here as a notification; carry on meanwhile.`
    }

    const timeoutMs = input.timeoutMs ?? this.options.timeoutMs
    const turn = await this.settle(member.info.id, messageID, timeoutMs, signal)

    if (turn === undefined) {
      this.watch(caller.id, member, messageID)

      return `"${member.name}" is still working after ${Math.round(timeoutMs / 1000)}s. Its reply will arrive here as a notification; carry on meanwhile, or use agents_read with wait: true.`
    }

    this.unwatch(member.info.id)

    return formatTurn(member, turn)
  }

  /**
   * Waits for the turn answering `messageID` to end. Returns undefined on
   * timeout. If the caller is stopped, the agent is interrupted too.
   */
  private async settle(sessionID: string, messageID: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<Turn | undefined> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const either = AbortSignal.any([signal, timeout, this.closed.signal])

    try {
      for (;;) {
        await this.host.wait(sessionID, either)

        const turn = turnAfter(await this.host.context(sessionID), messageID)

        if (turn.status !== "running") return turn

        // The message may not have started a turn yet when wait was asked.
        await sleep(250, either)
      }
    } catch (error) {
      if (aborted(signal)) {
        await this.host.interrupt(sessionID).catch(() => {})

        throw error
      }

      if (aborted(timeout) || aborted(this.closed.signal)) return undefined

      throw error
    }
  }

  private unwatch(sessionID: string): void {
    this.watchers.get(sessionID)?.abort()
    this.watchers.delete(sessionID)
  }

  /** Notifies `callerID` when the turn answering `messageID` ends; a newer watch on the same agent replaces it. */
  private watch(callerID: string, member: Member, messageID: string): void {
    this.unwatch(member.info.id)

    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.closed.signal])

    this.watchers.set(member.info.id, controller)

    void (async () => {
      let failures = 0

      while (!signal.aborted) {
        try {
          await this.host.wait(member.info.id, signal)

          const turn = turnAfter(await this.host.context(member.info.id), messageID)

          if (turn.status === "running") {
            await sleep(1_000, signal)

            continue
          }

          if (this.watchers.get(member.info.id) !== controller) return

          this.watchers.delete(member.info.id)
          await this.host.notify(callerID, formatTurn(member, turn), `Reply from ${member.name}`)

          return
        } catch (error) {
          if (signal.aborted) return

          failures += 1

          if (failures >= 5) {
            this.watchers.delete(member.info.id)
            await this.host
              .notify(callerID, `Lost track of agent "${member.name}" (${String(error)}). Use agents_read to check on it.`, `Lost track of ${member.name}`)
              .catch(() => {})

            return
          }

          await sleep(2_000 * failures, signal).catch(() => {})
        }
      }
    })()
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal.aborted) return fail(signal.reason)

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop)
      done()
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      fail(signal.reason)
    }

    signal.addEventListener("abort", stop, { once: true })
  })
}
