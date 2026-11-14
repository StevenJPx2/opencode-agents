type AgentEntry = { readonly id: string; readonly mode: "subagent" | "primary" | "all"; readonly hidden: boolean }

/**
 * The agent a new session runs when none is chosen, by OpenCode's documented fallback: build, else the first
 * visible primary-capable agent. Plugins cannot read `default_agent`, so it is not consulted.
 */
export function defaultAgent(agents: ReadonlyArray<AgentEntry>): string {
  const usable = agents.filter((agent) => !agent.hidden && agent.mode !== "subagent")
  const chosen = usable.find((agent) => agent.id === "build") ?? usable[0]

  if (chosen === undefined) throw new Error("No visible primary agent is configured. Pass agent to choose one.")

  return chosen.id
}
