import { readFile, stat } from "node:fs/promises"

/** A message file is pasted into a prompt, so it stays small enough to read. */
export const MAX_FILE_BYTES = 256 * 1024

export async function readText(path: string): Promise<string> {
  const { size } = await stat(path)

  if (size > MAX_FILE_BYTES) throw new Error(`it is ${Math.ceil(size / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB`)

  return readFile(path, "utf8")
}
