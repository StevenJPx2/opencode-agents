import { expect, test } from "bun:test"
import { listSessions } from "../src/sessions.ts"

type Input = { project?: string; cursor?: string; limit: number }

function paged(sessions: ReadonlyArray<{ id: string }>, calls: Input[]) {
  return async (input: Input) => {
    calls.push(input)

    const offset = Number(input.cursor ?? 0)
    const end = offset + input.limit

    return { data: sessions.slice(offset, end), cursor: end < sessions.length ? { next: String(end) } : {} }
  }
}

test("every session is collected across more than 100, keeping the project filter in the cursor", async () => {
  const sessions = Array.from({ length: 205 }, (_, index) => ({ id: `ses_${index}` }))
  const calls: Input[] = []

  expect(await listSessions(paged(sessions, calls), "prj_work")).toEqual(sessions)
  expect(calls).toEqual([
    { project: "prj_work", limit: 100 },
    { cursor: "100", limit: 100 },
    { cursor: "200", limit: 100 },
  ])
})

test("without a project every project's sessions are listed", async () => {
  const calls: Input[] = []

  await listSessions(paged([{ id: "ses_a" }], calls), undefined)

  expect(calls).toEqual([{ limit: 100 }])
})

test("an empty page ends the listing, whether the next cursor is missing or null", async () => {
  expect(await listSessions(async () => ({ data: [], cursor: {} }), "prj_work")).toEqual([])
  expect(await listSessions(async () => ({ data: [], cursor: { next: null } }), "prj_work")).toEqual([])
})

test("a later page failure is not silently returned as a partial list", async () => {
  await expect(listSessions(async (input) => {
    if (input.cursor) throw new Error("server unavailable")

    return { data: [{ id: "ses_first" }], cursor: { next: "next" } }
  }, "prj_work")).rejects.toThrow("server unavailable")
})
