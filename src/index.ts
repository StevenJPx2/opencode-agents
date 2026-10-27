import { Plugin } from "@opencode/plugin"
import { Agents, codeModeCall, directCall, MARKER_KEY, type Delivery, type Host, type SessionInfo } from "./agents.ts"
import { readText } from "./files.ts"
import { listSessions } from "./sessions.ts"
import type { Message } from "./transcript.ts"

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

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const ADDRESS = "The agent's name, or the ID of any session. A name is looked up in this project first, then in every project."

const FILE = {
  type: "string",
  description: "Path to a text file to load the message from, absolute or relative to your directory. With text as well, the text comes first, then the file.",
}

export default Plugin.define({
  id: "opencode-agents",
  async setup(ctx) {
    const codemode = ctx.options.codemode !== false

    const host: Host = {
      create: async (input) =>
        (await ctx.session.create({
          title: input.title,
          location: { directory: input.directory },
          metadata: { [MARKER_KEY]: input.marker },
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.model ? { model: input.model } : {}),
        })) as SessionInfo,
      rename: (sessionID, marker) => ctx.session.update({ sessionID, title: marker.name, metadata: { [MARKER_KEY]: marker } }),
      get: async (sessionID) => (await ctx.session.get({ sessionID })) as SessionInfo,
      sessions: async (projectID) => (await listSessions(ctx.session.list, projectID)) as ReadonlyArray<SessionInfo>,
      prompt: async ({ sessionID, text, delivery, from }) => {
        await ctx.session.prompt({ sessionID, text, delivery, metadata: { [MARKER_KEY]: { from } } })
      },
      context: async (sessionID) => (await ctx.session.context({ sessionID })) as unknown as ReadonlyArray<Message>,
      interrupt: async (sessionID) => {
        await ctx.session.interrupt({ sessionID, resume: false })
      },
      remove: (sessionID) => ctx.session.remove({ sessionID }),
      readText,
    }

    const agents = new Agents(host, codemode ? codeModeCall : directCall)

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "agents",
        description: [
          "Spawn independent OpenCode agents as top-level sessions the user can also open, and message them or any other session.",
          "Use to hand work to another agent, run work in parallel, ask for a review, or reply to a message headed [opencode-agents].",
          "Messages never wait; replies arrive as new messages.",
        ].join(" "),
      })

      const options = { namespace: "agents", codemode }

      editor.add({
        name: "spawn",
        description: [
          "Start a new agent in its own top-level session and send it a first message.",
          "It appears in the session history, where the user can open it and talk to it too.",
          "Returns at once: the agent works on its own and messages you back.",
          "Any agent can be used, including primary agents such as build and plan, on any model.",
        ].join(" "),
        input: schema(
          {
            prompt: { type: "string", description: "The first message: a complete, self-contained task, including what to send back. The agent cannot see your conversation." },
            file: FILE,
            name: { type: "string", description: "Short name to address the agent by, such as 'researcher'; unique within its project. Defaults to the agent ID." },
            agent: { type: "string", description: "Agent ID to run, such as build, plan, or explore. Defaults to the default agent." },
            model: { type: "string", description: "Model as provider/model, such as anthropic/claude-sonnet-5-5. Defaults to the agent's model." },
            directory: { type: "string", description: "Working directory for the agent, absolute or relative to yours. Defaults to yours." },
          },
        ),
        options,
        execute: async (raw, context) => {
          const input = raw as Input

          return {
            content: await agents.spawn(String(context.sessionID), {
              prompt: { text: text(input, "prompt"), file: text(input, "file") },
              name: text(input, "name"),
              agent: text(input, "agent"),
              model: text(input, "model"),
              directory: text(input, "directory"),
            }),
          }
        },
      })

      editor.add({
        name: "send",
        description: [
          "Send a message to an agent or any other session. It returns at once and never waits for a reply.",
          "The message is headed with who sent it, so the receiver can answer; its reply arrives here as a new message.",
        ].join(" "),
        input: schema(
          {
            to: { type: "string", description: ADDRESS },
            message: { type: "string", description: "The message to send." },
            file: FILE,
            delivery: {
              type: "string",
              enum: ["steer", "queue"],
              description: "If the receiver is busy: steer delivers at its next step (default); queue waits for its current turn to finish.",
            },
          },
          ["to"],
        ),
        options,
        execute: async (raw, context) => {
          const input = raw as Input
          const delivery: Delivery = input.delivery === "queue" ? "queue" : "steer"
          const message = { text: text(input, "message"), file: text(input, "file") }

          return { content: await agents.send(String(context.sessionID), { to: required(input, "to"), message, delivery }) }
        },
      })

      editor.add({
        name: "read",
        description: "Check on an agent or session: whether it is working, and its latest reply or recent conversation. It does not wait.",
        input: schema(
          {
            from: { type: "string", description: ADDRESS },
            messages: { type: "integer", minimum: 0, description: "Show this many recent messages of the conversation instead of only the latest reply." },
          },
          ["from"],
        ),
        options,
        execute: async (raw, context) => {
          const input = raw as Input
          const messages = typeof input.messages === "number" && input.messages > 0 ? Math.floor(input.messages) : 0

          return { content: await agents.read(String(context.sessionID), { from: required(input, "from"), messages }) }
        },
      })

      editor.add({
        name: "list",
        description: "List agents with their status: those in this project, or in every project with scope: global.",
        input: schema({
          scope: { type: "string", enum: ["project", "global"], description: "project (default) or global." },
        }),
        options,
        execute: async (raw, context) => {
          const scope = (raw as Input).scope === "global" ? "global" : "project"

          return { content: await agents.list(String(context.sessionID), scope) }
        },
      })

      editor.add({
        name: "stop",
        description: "Interrupt an agent this session spawned. Set remove: true to also delete its session.",
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

          return { content: await agents.stop(String(context.sessionID), { name: required(input, "name"), remove: flag(input, "remove", false) }) }
        },
      })
    })
  },
})
