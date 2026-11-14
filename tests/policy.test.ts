import { expect, test } from "bun:test"
import { defaultAgent } from "../src/defaults.ts"
import { denied } from "../src/permissions.ts"

const agent = (id: string, mode: "subagent" | "primary" | "all" = "primary", hidden = false) => ({ id, mode, hidden })

test("the default agent is build, else the first visible primary-capable agent", () => {
  expect(defaultAgent([agent("plan"), agent("build")])).toBe("build")
  expect(defaultAgent([agent("build", "primary", true), agent("explore", "subagent"), agent("writer", "all")])).toBe("writer")
  expect(() => defaultAgent([agent("explore", "subagent")])).toThrow("Pass agent to choose one.")
})

test("a denial names its action and resource; other rejections pass through", () => {
  const plain = new Error("rejected")

  const bare = String(denied({ _tag: "Tool.Error", message: "Permission denied: agents_spawn" }, "agents_spawn", "explore"))
  const feedback = String(denied({ _tag: "Tool.Error", message: "Not now, finish the tests" }, "agents_spawn", "explore"))

  expect(bare).toContain('Permission denied: agents_spawn on "explore".')
  expect(bare).not.toContain("OpenCode said")
  expect(feedback).toEndWith("OpenCode said: Not now, finish the tests")
  expect(denied(plain, "agents_spawn", "explore")).toBe(plain)
})
