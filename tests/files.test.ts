import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_FILE_BYTES, readText } from "../src/files.ts"

const dir = await mkdtemp(join(tmpdir(), "opencode-agents-"))

afterAll(() => rm(dir, { recursive: true, force: true }))

test("a message file is read as UTF-8 text up to the limit", async () => {
  const path = join(dir, "task.md")

  await writeFile(path, "Ünïcode task")

  expect(await readText(path)).toBe("Ünïcode task")

  await writeFile(path, "x".repeat(MAX_FILE_BYTES))

  expect(await readText(path)).toHaveLength(MAX_FILE_BYTES)
})

test("a file over the limit or a missing file is refused", async () => {
  const path = join(dir, "huge.md")

  await writeFile(path, "x".repeat(MAX_FILE_BYTES + 1))

  await expect(readText(path)).rejects.toThrow("the limit is 256 KB")
  await expect(readText(join(dir, "missing.md"))).rejects.toThrow("ENOENT")
})
