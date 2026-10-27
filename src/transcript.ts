/** The parts of a session message this plugin reads; the server sends more. */
export type Part = {
  readonly type: string
  readonly text?: string
  readonly name?: string
  readonly state?: { readonly status: string }
}

export type Message = {
  readonly id: string
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<Part>
  readonly error?: { readonly type: string; readonly message: string }
}

export type Turn = {
  /** `running` until the session goes idle after the message; `failed` when it went idle with an error. */
  readonly status: "running" | "done" | "failed"
  /** The text of the last assistant message in the turn that has any. */
  readonly reply: string
  readonly error?: string
  readonly toolCalls: number
}

export type Status = "new" | "running" | "idle" | "failed"

const CONVERSATION = new Set(["user", "synthetic", "assistant", "idle"])

const textOf = (message: Message): string =>
  (message.content ?? [])
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n")
    .trim()

const lastIndex = <T>(items: ReadonlyArray<T>, match: (item: T) => boolean): number => {
  for (let index = items.length - 1; index >= 0; index -= 1) if (match(items[index] as T)) return index

  return -1
}

/** The turn that answers the latest user message. */
export function latestTurn(messages: ReadonlyArray<Message>): Turn {
  const start = lastIndex(messages, (message) => message.type === "user")
  let reply = ""
  let toolCalls = 0
  let ended: Message | undefined

  // The first idle marker after the message closes the turn that answers it.
  for (const message of messages.slice(start + 1)) {
    if (message.type === "idle") {
      ended = message

      break
    }

    if (message.type !== "assistant") continue

    const text = textOf(message)

    if (text) reply = text

    toolCalls += (message.content ?? []).filter((part) => part.type === "tool").length
  }

  if (ended === undefined) return { status: "running", reply, toolCalls }
  if (ended.error) return { status: "failed", reply, error: ended.error.message, toolCalls }

  return { status: "done", reply, toolCalls }
}

/** Whether the session is working, judged by whether its conversation ends in an idle marker. */
export function statusOf(messages: ReadonlyArray<Message>): Status {
  const last = messages.findLast((message) => CONVERSATION.has(message.type))

  if (last === undefined) return "new"
  if (last.type !== "idle") return "running"

  return last.error ? "failed" : "idle"
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

/** The last `count` conversation messages as plain text, each clipped to `max` characters. */
export function transcript(messages: ReadonlyArray<Message>, count: number, max = 2_000): string {
  const lines = messages
    .filter((message) => message.type !== "idle" || message.error)
    .filter((message) => CONVERSATION.has(message.type))
    .slice(-count)
    .map((message) => {
      switch (message.type) {
        case "assistant": {
          const tools = (message.content ?? []).filter((part) => part.type === "tool").map((part) => part.name)
          const text = textOf(message)
          const calls = tools.length > 0 ? `[tools: ${tools.join(", ")}]` : ""

          return `assistant: ${[clip(text, max), calls].filter(Boolean).join(" ")}`
        }
        case "idle":
          return `error: ${message.error?.message ?? "unknown"}`
        default:
          return `${message.type}: ${clip(message.text ?? "", max)}`
      }
    })

  return lines.length > 0 ? lines.join("\n\n") : "(no messages yet)"
}
