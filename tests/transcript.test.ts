import { expect, test } from "bun:test"
import { statusOf, transcript, turnAfter, type Message } from "../src/transcript.ts"

const user = (id: string, text: string): Message => ({ id, type: "user", text })
const said = (id: string, text: string, tools: string[] = []): Message => ({
  id,
  type: "assistant",
  content: [...tools.map((name) => ({ type: "tool", name })), ...(text ? [{ type: "text", text }] : [])],
})
const idle = (id: string, error?: string): Message => (error ? { id, type: "idle", error: { type: "provider", message: error } } : { id, type: "idle" })

test("the reply is the last assistant text before the turn's idle marker", () => {
  const messages = [user("m1", "hi"), said("a1", "", ["glob"]), said("a2", "pong"), idle("i1"), user("m2", "again"), said("a3", "later")]

  expect(turnAfter(messages, "m1")).toEqual({ status: "done", reply: "pong", toolCalls: 1 })
})

test("a turn without an idle marker is still running", () => {
  const messages = [user("m1", "hi"), said("a1", "thinking", ["read"])]

  expect(turnAfter(messages, "m1")).toEqual({ status: "running", reply: "thinking", toolCalls: 1 })
})

test("an idle marker with an error fails the turn", () => {
  const messages = [user("m1", "hi"), idle("i1", "Model unavailable")]

  expect(turnAfter(messages, "m1")).toEqual({ status: "failed", reply: "", error: "Model unavailable", toolCalls: 0 })
})

test("without a message ID, or with one no longer in context, the latest user message is used", () => {
  const messages = [user("m1", "one"), said("a1", "first"), idle("i1"), user("m2", "two"), said("a2", "second"), idle("i2")]

  expect(turnAfter(messages).reply).toBe("second")
  expect(turnAfter(messages, "gone").reply).toBe("second")
})

test("status follows the last conversation message", () => {
  expect(statusOf([])).toBe("new")
  expect(statusOf([user("m1", "hi"), said("a1", "…")])).toBe("running")
  expect(statusOf([user("m1", "hi"), idle("i1"), { id: "x", type: "model-switched" }])).toBe("idle")
  expect(statusOf([user("m1", "hi"), idle("i1", "boom")])).toBe("failed")
})

test("the transcript shows recent messages, tool names, and errors", () => {
  const messages = [user("m1", "hi"), said("a1", "looking", ["glob", "read"]), idle("i1"), user("m2", "and?"), idle("i2", "boom")]

  expect(transcript(messages, 3)).toBe("assistant: looking [tools: glob, read]\n\nuser: and?\n\nerror: boom")
})
