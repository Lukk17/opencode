import { describe, expect } from "bun:test"
import { Message, SystemPart } from "@opencode/ai/effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { TodoReminderPlugin } from "@opencode/core/plugin/todo-reminder"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import type { TodoTool } from "@opencode/core/tool/plugin/todo"
import { Effect } from "effect"
import { it } from "../lib/effect"
import { host } from "./host"

const todowrite = { description: "Update the todo list", input: { type: "object" } } as const

const step = (todos?: TodoTool.Info[]) =>
  Message.assistant(
    todos ? [{ type: "tool-call", id: "call_todowrite", name: "todowrite", input: { todos } }] : "Working.",
  )

const open: TodoTool.Info[] = [
  { content: "Read", status: "completed" },
  { content: "Write", status: "in_progress" },
]

const request = (messages: Message[], tools: SessionContext["tools"] = { todowrite }): SessionContext => ({
  sessionID: Session.ID.make("ses_todo_reminder"),
  agent: Agent.ID.make("build"),
  model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") },
  system: [SystemPart.make("Agent prompt")],
  messages,
  tools,
  options: {},
})

/** Runs the plugin, then sends `event` through its `context` hook as the host would, and returns the request. */
const send = Effect.fnUntraced(function* (event: SessionContext) {
  const hooks = new Map<string, (input: SessionContext) => Effect.Effect<void>>()
  yield* TodoReminderPlugin.Plugin.effect(
    host({
      session: {
        hook: (hook, callback) => {
          hooks.set(hook, callback as (input: SessionContext) => Effect.Effect<void>)
          return Effect.succeed({ dispose: Effect.void })
        },
      },
    }),
  )
  yield* hooks.get("context")?.(event) ?? Effect.void
  return event
})

const history = (todos: TodoTool.Info[]) => [step(todos), step(), step(), step(), step(), step()]

describe("TodoReminderPlugin", () => {
  it.effect("reminds when the open list was not updated in the last 5 steps", () =>
    Effect.gen(function* () {
      const sent = yield* send(request(history(open)))
      expect(sent.messages).toEqual([...history(open), Message.user(TodoReminderPlugin.reminder)])
      expect(sent.system.map((part) => part.text)).toEqual(["Agent prompt"])
    }),
  )

  it.effect("does not remind when the list was updated within the last 5 steps", () =>
    Effect.gen(function* () {
      const sent = yield* send(request([step(open), step(), step(), step(), step()]))
      expect(sent.messages).toEqual([step(open), step(), step(), step(), step()])
    }),
  )

  it.effect("does not remind when every item is completed or cancelled", () =>
    Effect.gen(function* () {
      const done: TodoTool.Info[] = [
        { content: "Read", status: "completed" },
        { content: "Write", status: "cancelled" },
      ]
      const sent = yield* send(request(history(done)))
      expect(sent.messages).toEqual(history(done))
    }),
  )

  it.effect("does not remind when the request has no todowrite tool", () =>
    Effect.gen(function* () {
      const sent = yield* send(request(history(open), {}))
      expect(sent.messages).toEqual(history(open))
    }),
  )
})
