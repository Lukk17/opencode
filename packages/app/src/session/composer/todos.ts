import type { Todo } from "@opencode/session-ui/todos"

export { sessionTodos, todoFinished, type Todo, type TodoStatus } from "@opencode/session-ui/todos"

/** The todo the agent is on: the one in progress, else the next pending one, else the last finished one. */
export function currentTodo(todos: readonly Todo[]) {
  return (
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending") ??
    todos.findLast((todo) => todo.status === "completed") ??
    todos[0]
  )
}
