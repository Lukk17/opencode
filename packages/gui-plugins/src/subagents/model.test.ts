import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import type { Todo } from "@opencode/session-ui/todos"
import { autoOpen, experimentalSettings, subagentStatus, subagentTree, todoProgress } from "./model"

const session = (id: string, parentID: string | undefined, created: number) =>
  ({
    id,
    parentID,
    projectID: "project-1",
    agent: "explore",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, updated: created },
    location: { directory: "/repo" },
  }) satisfies SessionInfo

const todowrite = (id: string, todos: Todo[]): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "explore",
  model: { id: "model-1", providerID: "provider-1" },
  content: [
    {
      type: "tool",
      id: `tool_${id}`,
      name: "todowrite",
      state: { status: "completed", input: { todos }, content: [{ type: "text", text: "Todos updated" }] },
      time: { created: 1, ran: 1 },
    },
  ],
  time: { created: 1 },
})

describe("subagentTree", () => {
  test("lists only the descendants of the open session", () => {
    const tree = subagentTree("a", [
      session("root", undefined, 0),
      session("a", "root", 1),
      session("a1", "a", 2),
      session("b", "root", 3),
      session("other", undefined, 4),
      session("other1", "other", 5),
    ])

    expect(tree.map((node) => node.id)).toEqual(["a1"])
  })

  test("puts each subagent after its parent, one level deeper", () => {
    const tree = subagentTree("root", [session("b", "root", 3), session("a", "root", 1), session("a1", "a", 2)])

    expect(tree).toEqual([
      { id: "a", depth: 0 },
      { id: "a1", depth: 1 },
      { id: "b", depth: 0 },
    ])
  })
})

describe("subagentStatus", () => {
  test("shows a running subagent as running whatever its last outcome", () => {
    expect(
      (["succeeded", "failed", "interrupted", undefined] as const).map((outcome) => subagentStatus(outcome, true)),
    ).toEqual(["running", "running", "running", "running"])
  })

  test("maps each outcome, and no outcome, to a status", () => {
    expect(
      (["succeeded", "failed", "interrupted", undefined] as const).map((outcome) => subagentStatus(outcome, false)),
    ).toEqual(["finished", "failed", "cancelled", "notStarted"])
  })
})

describe("todoProgress", () => {
  test("counts the latest completed todowrite", () => {
    const progress = todoProgress([
      todowrite("m1", [{ content: "Old", status: "completed" }]),
      todowrite("m2", [
        { content: "Read", status: "completed" },
        { content: "Skip", status: "cancelled" },
        { content: "Write", status: "in_progress" },
      ]),
    ])

    expect(progress).toEqual({ done: 2, total: 3 })
  })

  test("is undefined without a todowrite", () => {
    expect(todoProgress([])).toBeUndefined()
  })
})

test("opens the panel by itself only once per session", () => {
  expect([
    autoOpen({ enabled: true, opened: undefined, running: true, mainOpen: false }),
    autoOpen({ enabled: true, opened: false, running: false, mainOpen: false }),
    autoOpen({ enabled: true, opened: false, running: true, mainOpen: false }),
    autoOpen({ enabled: true, opened: true, running: true, mainOpen: false }),
  ]).toEqual([false, false, true, false])
})

test("opens the panel by itself in a subagent's chat when the main chat has it open", () => {
  expect([
    autoOpen({ enabled: true, opened: false, running: false, mainOpen: true }),
    autoOpen({ enabled: true, opened: true, running: false, mainOpen: true }),
  ]).toEqual([true, false])
})

test("never opens the panel by itself while auto-open is disabled", () => {
  expect([
    autoOpen({ enabled: false, opened: false, running: true, mainOpen: false }),
    autoOpen({ enabled: false, opened: false, running: false, mainOpen: true }),
  ]).toEqual([false, false])
})

test("reads the experimental settings of the highest-priority document that sets any", () => {
  expect(
    experimentalSettings([
      { type: "document", info: { experimental: { agents_panel_auto_open: false } } },
      { type: "document", info: { experimental: { todo: true } } },
      { type: "document", info: {} },
    ]),
  ).toEqual({ todo: true })
  expect(experimentalSettings([{ type: "document", info: {} }])).toBeUndefined()
})
