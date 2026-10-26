import { Plugin } from "@opencode/plugin"
import type { Message } from "./transcript.ts"
import { MARKER_KEY, Team, type Delivery, type Host, type SessionInfo } from "./team.ts"

const DEFAULTS = { maxDepth: 2, maxAgents: 8, timeoutSeconds: 600 }

function positive(option: unknown, fallback: number): number {
  return typeof option === "number" && Number.isInteger(option) && option > 0 ? option : fallback
}

type Input = Readonly<Record<string, unknown>>

const text = (input: Input, key: string): string | undefined => {
  const value = input[key]

  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

const required = (input: Input, key: string): string => {
  const value = text(input, key)

  if (value === undefined) throw new Error(`"${key}" is required.`)

  return value
}

const flag = (input: Input, key: string, fallback: boolean): boolean => (typeof input[key] === "boolean" ? (input[key] as boolean) : fallback)

const seconds = (input: Input): number | undefined => {
  const value = input.timeoutSeconds

  return typeof value === "number" && value > 0 ? Math.round(value * 1000) : undefined
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const TIMEOUT = {
  type: "number",
  description: "How long to wait for the reply, in seconds, before it is delivered later as a notification instead.",
}

export default Plugin.define({
  id: "opencode-agents",
  async setup(ctx) {
    const timeoutMs = positive(ctx.options.timeoutSeconds, DEFAULTS.timeoutSeconds) * 1000
    const codemode = ctx.options.codemode === true

    const host: Host = {
      create: async (input) =>
        (await ctx.session.create({
          parentID: input.parentID,
          title: input.title,
          location: { directory: input.directory },
          metadata: { [MARKER_KEY]: { name: input.marker.name, depth: input.marker.depth } },
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.model ? { model: input.model } : {}),
        })) as SessionInfo,
      get: async (sessionID) => (await ctx.session.get({ sessionID })) as SessionInfo,
      children: async (parentID) => (await ctx.session.list({ parentID, limit: 100 })).data as ReadonlyArray<SessionInfo>,
      prompt: async (sessionID, text, delivery) => String((await ctx.session.prompt({ sessionID, text, delivery })).id),
      wait: (sessionID, signal) => ctx.session.wait({ sessionID }, { signal }),
      context: async (sessionID) => (await ctx.session.context({ sessionID })) as unknown as ReadonlyArray<Message>,
      interrupt: async (sessionID) => {
        await ctx.session.interrupt({ sessionID, resume: false })
      },
      remove: (sessionID) => ctx.session.remove({ sessionID }),
      notify: async (sessionID, text, description) => {
        await ctx.session.synthetic({ sessionID, text, description, resume: true })
      },
    }

    const team = new Team(host, {
      maxDepth: positive(ctx.options.maxDepth, DEFAULTS.maxDepth),
      maxAgents: positive(ctx.options.maxAgents, DEFAULTS.maxAgents),
      timeoutMs,
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "agents",
        description:
          "Spawn OpenCode agents as their own sessions and hold conversations with them. Each agent keeps its context between messages, so you can delegate work, ask follow-up questions, and run several agents in parallel.",
      })

      const options = { namespace: "agents", codemode }

      editor.add({
        name: "spawn",
        description: [
          "Start a new agent in its own session and give it a first task.",
          "The agent keeps its conversation, so you can send it follow-up messages later with agents_send.",
          "Any agent can be used, including primary agents such as build and plan, on any model.",
          "By default this waits for the first reply; set wait: false to run it in the background and get its reply as a notification.",
          "The user can also open the agent's session and talk to it directly.",
        ].join(" "),
        input: schema(
          {
            prompt: { type: "string", description: "The first message: a complete, self-contained task. The agent cannot see your conversation." },
            name: { type: "string", description: "Short name to address the agent by, such as 'researcher'. Defaults to the agent ID." },
            agent: { type: "string", description: "Agent ID to run, such as build, plan, or explore. Defaults to the default agent." },
            model: { type: "string", description: "Model as provider/model, such as anthropic/claude-sonnet-5-5. Defaults to the agent's model." },
            directory: { type: "string", description: "Working directory for the agent, absolute or relative to yours. Defaults to yours." },
            wait: { type: "boolean", description: "Wait for the first reply (default true)." },
            timeoutSeconds: TIMEOUT,
          },
          ["prompt"],
        ),
        options,
        execute: async (raw, context) => {
          const input = raw as Input

          return {
            content: await team.spawn(
              String(context.sessionID),
              {
                prompt: required(input, "prompt"),
                name: text(input, "name"),
                agent: text(input, "agent"),
                model: text(input, "model"),
                directory: text(input, "directory"),
                wait: flag(input, "wait", true),
                timeoutMs: seconds(input),
              },
              context.signal,
            ),
          }
        },
      })

      editor.add({
        name: "send",
        description: [
          "Send a message to an agent you spawned and, by default, wait for its reply.",
          "Use it for follow-up questions, corrections, or new tasks in the same context.",
          "Spawned agents can also message their siblings; those messages never wait, and the reply arrives as a notification.",
        ].join(" "),
        input: schema(
          {
            to: { type: "string", description: "The agent's name or session ID." },
            message: { type: "string", description: "The message to send." },
            wait: { type: "boolean", description: "Wait for the reply (default true). When false, the reply arrives later as a notification." },
            delivery: {
              type: "string",
              enum: ["steer", "queue"],
              description: "If the agent is busy: steer delivers at its next step (default); queue waits for its current turn to finish.",
            },
            timeoutSeconds: TIMEOUT,
          },
          ["to", "message"],
        ),
        options,
        execute: async (raw, context) => {
          const input = raw as Input
          const delivery: Delivery = input.delivery === "queue" ? "queue" : "steer"

          return {
            content: await team.send(
              String(context.sessionID),
              { to: required(input, "to"), message: required(input, "message"), wait: flag(input, "wait", true), delivery, timeoutMs: seconds(input) },
              context.signal,
            ),
          }
        },
      })

      editor.add({
        name: "read",
        description: "Check on an agent: whether it is working, and its latest reply or recent conversation. Set wait: true to wait for it to finish its current turn.",
        input: schema(
          {
            from: { type: "string", description: "The agent's name or session ID." },
            wait: { type: "boolean", description: "Wait for the current turn to finish (default false)." },
            messages: { type: "integer", minimum: 0, description: "Show this many recent messages of the conversation instead of only the latest reply." },
            timeoutSeconds: TIMEOUT,
          },
          ["from"],
        ),
        options,
        execute: async (raw, context) => {
          const input = raw as Input
          const messages = typeof input.messages === "number" && input.messages > 0 ? Math.floor(input.messages) : 0

          return {
            content: await team.read(
              String(context.sessionID),
              { from: required(input, "from"), wait: flag(input, "wait", false), messages, timeoutMs: seconds(input) },
              context.signal,
            ),
          }
        },
      })

      editor.add({
        name: "list",
        description: "List the agents spawned from this session (and, for a spawned agent, its siblings) with their status.",
        input: schema({}),
        options,
        execute: async (_raw, context) => ({ content: await team.list(String(context.sessionID)) }),
      })

      editor.add({
        name: "stop",
        description: "Interrupt an agent you spawned. Set remove: true to also delete its session when you no longer need it.",
        input: schema(
          {
            name: { type: "string", description: "The agent's name or session ID." },
            remove: { type: "boolean", description: "Delete the agent's session as well (default false)." },
          },
          ["name"],
        ),
        options,
        execute: async (raw, context) => {
          const input = raw as Input

          return { content: await team.stop(String(context.sessionID), { name: required(input, "name"), remove: flag(input, "remove", false) }) }
        },
      })
    })

    return () => team.close()
  },
})
