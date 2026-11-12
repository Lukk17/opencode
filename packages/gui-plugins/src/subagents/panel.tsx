import { createMemo, For, Match, Show, Switch } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { sessionTodos, type Todo } from "@opencode/session-ui/todos"
import { createKeyed, usePlugin, type MountedSession } from "@opencode/plugin/gui"
import type Subagents from "./index"
import {
  experimentalSettings,
  subagentStatus,
  subagentTree,
  todoProgress,
  type SubagentDetails,
  type SubagentNode,
} from "./model"

/** The routed session's sidebar: its own todo list and every subagent below it, read from its server's data. */
export default function SubagentsTab(props: { session: MountedSession }) {
  const ctx = usePlugin<typeof Subagents>()
  const data = () => props.session.server.data

  const tree = createMemo(
    () =>
      subagentTree(
        props.session.id,
        data()
          .session.family(props.session.id)
          .flatMap((id) => data().session.get(id) ?? []),
      ),
    [],
    {
      equals: (a, b) =>
        a.length === b.length && a.every((node, index) => node.id === b[index]?.id && node.depth === b[index]?.depth),
    },
  )

  const todosEnabled = createMemo(
    () =>
      experimentalSettings(data().location.config.list({ directory: props.session.directory }) ?? [])?.todo === true,
  )

  const todos = createMemo(() =>
    todosEnabled()
      ? sessionTodos(
          data().session.message.list(props.session.id),
          data().session.get(props.session.id)?.revert?.messageID,
        )
      : [],
  )

  const running = createMemo(() => tree().filter((node) => data().session.status(node.id) === "running").length)

  createKeyed(
    () => props.session.server.connected && [props.session.id, ...tree().map((node) => node.id)].join("\n"),
    (ids) =>
      ids.split("\n").forEach((id, index) => {
        void data().session.sync(id, { children: true }).catch(console.error)

        if (index > 0) void data().session.message.sync(id).catch(console.error)
      }),
  )

  return (
    <SubagentList
      rows={tree()}
      running={running()}
      todos={todos()}
      details={(id) => {
        const info = data().session.get(id)

        return {
          agent: info?.agent,
          title: info?.title,
          status: subagentStatus(info?.outcome, data().session.status(id) === "running"),
          todos: todosEnabled() ? todoProgress(data().session.message.list(id), info?.revert?.messageID) : undefined,
        }
      }}
      onOpen={(id) => ctx.tabs.open({ server: props.session.server.id, id }, { from: props.session.id })}
    />
  )
}

/** The sidebar's content: a header with the counts, the session's todos, and one row per subagent. */
export function SubagentList(props: {
  rows: readonly SubagentNode[]
  running: number
  todos: readonly Todo[]
  details: (sessionID: string) => SubagentDetails
  onOpen: (sessionID: string) => void
}) {
  const ctx = usePlugin<typeof Subagents>()

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="subagents-panel">
      <div class="flex shrink-0 items-center gap-2 px-3 py-2 text-[12px] leading-4 text-v2-text-text-muted">
        <span>{ctx.plural("header.count", props.rows.length)}</span>
        <Show when={props.running > 0}>
          <span aria-hidden="true">·</span>
          <span>{ctx.t("header.running", { count: props.running })}</span>
        </Show>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-2" data-scrollable>
        <Show when={props.todos.length > 0}>
          <div class="px-2 pt-1 pb-1 text-[12px] leading-4 text-v2-text-text-faint">{ctx.t("todos.title")}</div>
          <For each={props.todos}>
            {(todo) => (
              <div data-slot="subagents-todo" class="flex items-start gap-2 px-2 py-1 text-[13px] leading-5">
                <span class="flex h-5 w-4 shrink-0 items-center justify-center text-v2-icon-icon-faint">
                  <Switch fallback={<Icon name="dash" size="small" />}>
                    <Match when={todo.status === "in_progress"}>
                      <SessionProgressIndicatorV2 />
                    </Match>
                    <Match when={todo.status === "completed"}>
                      <Icon name="check" size="small" />
                    </Match>
                    <Match when={todo.status === "cancelled"}>
                      <Icon name="outline-xmark" size="small" />
                    </Match>
                  </Switch>
                </span>
                <span
                  dir="auto"
                  classList={{
                    "min-w-0 flex-1": true,
                    "text-v2-text-text-base": todo.status === "in_progress" || todo.status === "pending",
                    "text-v2-text-text-faint line-through": todo.status === "cancelled",
                    "text-v2-text-text-muted": todo.status === "completed",
                  }}
                >
                  {todo.content}
                </span>
              </div>
            )}
          </For>
          <div class="mx-2 my-1 h-px bg-v2-border-border-base" />
        </Show>
        <Show
          when={props.rows.length > 0}
          fallback={<div class="px-2 py-1 text-[13px] leading-5 text-v2-text-text-faint">{ctx.t("empty")}</div>}
        >
          <For each={props.rows}>
            {(row) => {
              const view = createMemo(() => props.details(row.id))

              return (
                <button
                  type="button"
                  data-slot="subagents-row"
                  data-status={view().status}
                  class="flex w-full min-w-0 items-start gap-2 rounded-[4px] py-1 pe-2 text-start hover:bg-v2-overlay-simple-overlay-hover"
                  style={{ "padding-inline-start": `${8 + row.depth * 16}px` }}
                  title={ctx.t(`status.${view().status}`)}
                  onClick={() => props.onOpen(row.id)}
                >
                  <span class="flex h-5 w-4 shrink-0 items-center justify-center text-v2-icon-icon-faint">
                    <Switch fallback={<Icon name="dash" size="small" />}>
                      <Match when={view().status === "running"}>
                        <SessionProgressIndicatorV2 />
                      </Match>
                      <Match when={view().status === "finished"}>
                        <Icon name="check" size="small" />
                      </Match>
                      <Match when={view().status === "failed"}>
                        <Icon name="circle-xmark" size="small" />
                      </Match>
                      <Match when={view().status === "cancelled"}>
                        <Icon name="outline-xmark" size="small" />
                      </Match>
                    </Switch>
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-v2-text-text-base">
                      <span class="min-w-0 flex-1 truncate capitalize">{view().agent}</span>
                      <Show when={view().todos}>
                        {(todos) => (
                          <span
                            class="shrink-0 text-[12px] tabular-nums text-v2-text-text-muted"
                            title={ctx.t("todo.progress", { done: todos().done, total: todos().total })}
                          >
                            {todos().done}/{todos().total}
                          </span>
                        )}
                      </Show>
                    </span>
                    <span dir="auto" class="truncate text-[12px] leading-4 text-v2-text-text-muted">
                      {view().title || ctx.t("untitled")}
                    </span>
                    <span class="text-[12px] leading-4 text-v2-text-text-faint">
                      {ctx.t(`status.${view().status}`)}
                    </span>
                  </span>
                </button>
              )
            }}
          </For>
        </Show>
      </div>
    </div>
  )
}
