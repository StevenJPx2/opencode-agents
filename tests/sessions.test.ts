import { expect, test } from "bun:test"
import { listChildren } from "../src/sessions.ts"

test("all children are collected across more than 100 sessions, preserving the cursor's filters", async () => {
  const children = Array.from({ length: 205 }, (_, index) => ({ id: `ses_${index}` }))
  const calls: Array<{ parentID?: string; cursor?: string; limit: number }> = []
  const list = async (input: { parentID?: string; cursor?: string; limit: number }) => {
    calls.push(input)

    const offset = Number(input.cursor ?? 0)
    const end = offset + input.limit

    return { data: children.slice(offset, end), cursor: end < children.length ? { next: String(end) } : {} }
  }

  expect(await listChildren(list, "ses_root")).toEqual(children)
  expect(calls).toEqual([
    { parentID: "ses_root", limit: 100 },
    { cursor: "100", limit: 100 },
    { cursor: "200", limit: 100 },
  ])
})

test("a session with no children returns an empty list", async () => {
  expect(await listChildren(async () => ({ data: [], cursor: {} }), "ses_root")).toEqual([])
  expect(await listChildren(async () => ({ data: [], cursor: { next: null } }), "ses_root")).toEqual([])
})

test("a later page failure is not silently returned as a partial team", async () => {
  await expect(listChildren(async (input) => {
    if (input.cursor) throw new Error("server unavailable")

    return { data: [{ id: "ses_first" }], cursor: { next: "next" } }
  }, "ses_root")).rejects.toThrow("server unavailable")
})
