export * as TodoReminderPlugin from "./todo-reminder.js"

import { Message } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { TodoTool } from "../tool/plugin/todo.js"

export const reminder = `<system-reminder>
Your todo list has unfinished items and you have not updated it in the last 5 steps. Call todowrite to update it now.
</system-reminder>`

const steps = 5

const decodeInput = Schema.decodeUnknownOption(TodoTool.Input)

export const Plugin = define({
  id: "opencode.prompt.todo-reminder",
  effect: Effect.fn("TodoReminderPlugin")(function* (ctx) {
    yield* ctx.session.hook("context", (event) => {
      if (!event.tools[TodoTool.name] || !stale(event.messages)) return Effect.void
      const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
      event.messages.splice(at, 0, Message.user(reminder))
      return Effect.void
    })
  }),
})

function stale(messages: ReadonlyArray<Message>) {
  const assistant = messages.flatMap((message) => (message.role === "assistant" ? [message] : []))
  const index = assistant.findLastIndex((message) =>
    message.content.some((part) => part.type === "tool-call" && part.name === TodoTool.name),
  )
  if (index === -1 || assistant.length - 1 - index < steps) return false
  const call = assistant[index]?.content.findLast((part) => part.type === "tool-call" && part.name === TodoTool.name)
  return decodeInput(call?.type === "tool-call" ? call.input : undefined).pipe(
    Option.exists((input) => input.todos.some((todo) => todo.status !== "completed" && todo.status !== "cancelled")),
  )
}
