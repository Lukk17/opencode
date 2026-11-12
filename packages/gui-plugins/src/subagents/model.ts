import type { ConfigEntry, SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { sessionTodos, todoFinished } from "@opencode/session-ui/todos"

/** Where a subagent stands: its run, else the outcome of its last run, else `notStarted`. */
export type SubagentStatus = "running" | "finished" | "failed" | "cancelled" | "notStarted"

/** A subagent's place in the tree below the open session. */
export type SubagentNode = {
  readonly id: string
  /** 0 for a direct subagent of the open session, 1 for its subagents, and so on. */
  readonly depth: number
}

/** What one subagent row shows. */
export type SubagentDetails = {
  readonly agent?: string
  readonly title?: string
  readonly status: SubagentStatus
  /** Finished and total items of its latest todo list; undefined when it has none. */
  readonly todos?: { readonly done: number; readonly total: number }
}

const outcomes = { succeeded: "finished", failed: "failed", interrupted: "cancelled" } as const

/** The descendants of `sessionID` among `sessions`, each after its parent and oldest first. */
export function subagentTree(sessionID: string, sessions: readonly SessionInfo[]) {
  const children = sessions.reduce((map, session) => {
    if (session.parentID) map.set(session.parentID, [...(map.get(session.parentID) ?? []), session])

    return map
  }, new Map<string, SessionInfo[]>())

  const walk = (parentID: string, depth: number): SubagentNode[] =>
    (children.get(parentID) ?? [])
      .toSorted((a, b) => a.time.created - b.time.created)
      .flatMap((session) => [{ id: session.id, depth }, ...walk(session.id, depth + 1)])

  return walk(sessionID, 0)
}

/** `running` while the subagent runs, else its last outcome, else `notStarted`. */
export const subagentStatus = (outcome: SessionInfo["outcome"], running: boolean): SubagentStatus =>
  running ? "running" : outcome ? outcomes[outcome] : "notStarted"

/** Finished and total items of the latest todo list in `messages`; undefined when there is none. */
export function todoProgress(messages: readonly SessionMessageInfo[], boundary?: string) {
  const todos = sessionTodos(messages, boundary)

  return todos.length > 0 ? { done: todos.filter(todoFinished).length, total: todos.length } : undefined
}

/** The `experimental` settings of the highest-priority config document that sets any. */
export const experimentalSettings = (entries: readonly ConfigEntry[]) =>
  entries
    .flatMap((entry) => (entry.type === "document" && entry.info.experimental ? [entry.info.experimental] : []))
    .at(-1)

/**
 * Whether the panel opens by itself: while `enabled`, once per session, after its stored flag loads, while a subagent
 * runs or while the main chat of the session's tab has it open.
 */
export const autoOpen = (input: {
  readonly enabled: boolean
  readonly opened: boolean | undefined
  readonly running: boolean
  readonly mainOpen: boolean
}) => input.enabled && input.opened === false && (input.running || input.mainOpen)
