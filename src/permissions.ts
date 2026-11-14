/** OpenCode rejects a denied permission check with a tagged Tool.Error carrying the reason. */
const isToolError = (error: unknown): error is { readonly message: string } =>
  typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "Tool.Error"

/**
 * OpenCode's reason names only the action, so a denial also names the resource and the rule that
 * matches it. Any other rejection, such as the user's plain reject that ends the step, passes through.
 */
export function denied(error: unknown, action: string, resource: string): unknown {
  if (!isToolError(error)) return error

  const reason = error.message.trim()
  const rule = `{ action: "${action}", resource: "${resource}" or a pattern matching it such as "*", effect: "deny" }`
  const lines = [
    `Permission denied: ${action} on "${resource}".`,
    `A rule ${rule} applies to this session, from its agent's permissions, the config, or the session's own rules.`,
  ]

  // A rejection with feedback carries the user's words; the bare denial repeats the action only.
  if (reason !== "" && reason !== `Permission denied: ${action}`) lines.push(`OpenCode said: ${reason}`)

  return new Error(lines.join(" "))
}
