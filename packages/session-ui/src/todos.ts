import type { SessionMessageInfo } from "@opencode/client/promise"
import { Option, Schema } from "effect"

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export type Todo = {
  content: string
  status: TodoStatus
}

const decodeList = Schema.decodeUnknownOption(Schema.Struct({ todos: Schema.Array(Schema.Unknown) }))

const decodeItem = Schema.decodeUnknownOption(
  Schema.Struct({ content: Schema.NonEmptyString, status: Schema.optional(Schema.Unknown) }),
)

const decodeStatus = Schema.decodeUnknownOption(Schema.Literals(["pending", "in_progress", "completed", "cancelled"]))

// The experimental `todowrite` tool keeps no server state: the current list is the input of the latest completed call
// before the revert boundary.
export function sessionTodos(messages: readonly SessionMessageInfo[], boundary?: string): Todo[] {
  const end = boundary ? messages.findIndex((message) => message.id === boundary) : -1

  const input = messages
    .slice(0, end === -1 ? messages.length : end)
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .findLast((item) => item.type === "tool" && item.name === "todowrite" && item.state.status === "completed")

  if (input?.type !== "tool" || input.state.status !== "completed") return []

  return Option.match(decodeList(input.state.input), {
    onNone: () => [],
    onSome: (list) =>
      list.todos.flatMap((item) =>
        Option.match(decodeItem(item), {
          onNone: () => [],
          onSome: (todo) => [
            { content: todo.content, status: Option.getOrElse(decodeStatus(todo.status), () => "pending" as const) },
          ],
        }),
      ),
  })
}

export const todoFinished = (todo: Todo) => todo.status === "completed" || todo.status === "cancelled"
