import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import type { Todo } from "@opencode/session-ui/todos"
import { SubagentList } from "./panel"
import { subagentStatus, subagentTree, todoProgress } from "./model"

type Fixture = {
  readonly id: string
  readonly parent?: string
  readonly agent: string
  readonly title: string
  readonly outcome?: SessionInfo["outcome"]
  readonly running?: boolean
  readonly todos?: Todo[]
}

const session = (fixture: Fixture, index: number) =>
  ({
    id: fixture.id,
    parentID: fixture.parent ?? "root",
    projectID: "project-1",
    agent: fixture.agent,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: index, updated: index },
    title: fixture.title,
    outcome: fixture.outcome,
    location: { directory: "/repo" },
  }) satisfies SessionInfo

const todowrite = (todos: Todo[]): SessionMessageInfo[] => [
  {
    id: "msg_todos",
    type: "assistant",
    agent: "build",
    model: { id: "model-1", providerID: "provider-1" },
    content: [
      {
        type: "tool",
        id: "tool_todowrite",
        name: "todowrite",
        state: { status: "completed", input: { todos }, content: [{ type: "text", text: "Todos updated" }] },
        time: { created: 1, ran: 1 },
      },
    ],
    time: { created: 1 },
  },
]

const plan = (done: number, total: number): Todo[] =>
  Array.from({ length: total }, (_, index) => ({
    content: `Step ${index + 1}`,
    status: index < done ? "completed" : index === done ? "in_progress" : "pending",
  }))

const story = (fixtures: Fixture[], todos: Todo[] = []) => ({
  render: () => {
    const tree = subagentTree("root", fixtures.map(session))

    const details = (id: string) => {
      const fixture = fixtures.find((item) => item.id === id)

      return {
        agent: fixture?.agent,
        title: fixture?.title,
        status: subagentStatus(fixture?.outcome, fixture?.running === true),
        todos: fixture?.todos ? todoProgress(todowrite(fixture.todos)) : undefined,
      }
    }

    return (
      <div class="h-[560px] w-[320px] border border-v2-border-border-base">
        <SubagentList
          rows={tree}
          running={fixtures.filter((fixture) => fixture.running).length}
          todos={todos}
          details={details}
          onOpen={() => {}}
        />
      </div>
    )
  },
})

export default {
  title: "Plugins/Subagents",
  id: "plugins-subagents",
  parameters: {
    docs: {
      description: {
        component: "The Agents side panel: the session's todo list and one row per subagent, nested under its parent.",
      },
    },
  },
}

/** The session has started no subagent yet. */
export const Empty = story([])

/** One subagent in each status. */
export const MixedStatuses = story([
  { id: "a", agent: "explore", title: "Map the session screen", running: true },
  { id: "b", agent: "general", title: "Read the panel registry", outcome: "succeeded" },
  { id: "c", agent: "general", title: "Run the app typecheck", outcome: "failed" },
  { id: "d", agent: "explore", title: "Search for older sidebars", outcome: "interrupted" },
  { id: "e", agent: "review", title: "Review the change" },
])

/** Subagents that started subagents of their own, indented under them. */
export const Nested = story([
  { id: "a", agent: "general", title: "Build the sidebar", running: true },
  { id: "a1", parent: "a", agent: "explore", title: "Find the panel pattern", outcome: "succeeded" },
  { id: "a2", parent: "a", agent: "general", title: "Write the model", running: true },
  { id: "a2x", parent: "a2", agent: "explore", title: "Read the todo helpers", running: true },
  { id: "b", agent: "review", title: "Review the change" },
])

/** The session's own todo list, and subagents with todo progress. */
export const WithTodos = story(
  [
    { id: "a", agent: "general", title: "Build the sidebar", running: true, todos: plan(3, 7) },
    { id: "b", agent: "general", title: "Write the docs", outcome: "succeeded", todos: plan(4, 4) },
    { id: "c", agent: "explore", title: "Map the session screen", outcome: "succeeded" },
  ],
  [
    { content: "Plan the sidebar", status: "completed" },
    { content: "Build the panel", status: "in_progress" },
    { content: "Drop the old dock", status: "cancelled" },
    { content: "Write the docs", status: "pending" },
  ],
)

/** More subagents than fit, so the list scrolls under a fixed header. */
export const Many = story(
  Array.from({ length: 30 }, (_, index) => ({
    id: `s${index}`,
    agent: index % 3 === 0 ? "explore" : "general",
    title: `Check package ${index + 1}`,
    running: index % 4 === 0,
    outcome: index % 4 === 0 ? undefined : (["succeeded", "failed", "interrupted"] as const)[index % 3],
    todos: index % 2 === 0 ? plan(index % 5, 5) : undefined,
  })),
)
