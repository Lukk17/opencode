import { expect, test } from "bun:test"
import { SUBAGENT_TASK_METADATA } from "@opencode/util/subagent-task"
import { createAppFixture } from "./fixture/app"
import { waitForHighlightedFrame } from "./fixture/frame"
import { directory, json } from "./fixture/tui-client"

const session = {
  id: "ses_collapsed",
  title: "Collapsed messages",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

const child = { ...session, id: "ses_child_task", title: "Child", parentID: session.id }

const task = {
  id: "task",
  type: "user",
  text: "You are a subagent spawned by another session.\nFind where the setting is stored",
  metadata: SUBAGENT_TASK_METADATA,
  time: { created: 0 },
}

const messages = [
  { id: "typed", type: "user", text: "Fix the timeline setting", time: { created: 0 } },
  {
    id: "fork",
    type: "synthetic",
    text: "Fork notice body",
    description: "Fork notice",
    time: { created: 1 },
  },
  { id: "skill", type: "skill", skill: "review", name: "review", text: "Skill body", time: { created: 2 } },
  {
    id: "system",
    type: "system",
    text: "Instruction body",
    description: "Instructions updated: AGENTS.md",
    time: { created: 3 },
  },
  { ...task, time: { created: 4 } },
]

const parentMessages = [
  { id: "run", type: "user", text: "Run a subagent", time: { created: 0 } },
  {
    id: "result",
    type: "synthetic",
    text: "Subagent result",
    description: "Find the setting",
    metadata: { source: "subagent", childID: child.id, agent: "general", state: "completed" },
    time: { created: 1 },
  },
]

function answer(text: string) {
  return {
    id: "answer",
    type: "assistant",
    agent: "general",
    model: { providerID: "test", id: "test" },
    content: [{ type: "text", text }],
    finish: "stop",
    time: { created: 1, completed: 2 },
  }
}

const longAnswer = answer(
  ["Answer start", ...Array.from({ length: 30 }, (_, index) => `Answer line ${index}`)].join("\n\n"),
)

function open(input: { sessionID: string; messages: Record<string, unknown[]> }) {
  const sessions = [session, child]
  return createAppFixture({
    width: 80,
    height: 30,
    config: { animations: false, tabs: { mode: "off" }, keybinds: { "session.message.toggle": "ctrl+shift+o" } },
    args: { sessionID: input.sessionID },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
      const match = sessions.find((item) => url.pathname.split("/")[3] === item.id)
      if (!match) return
      if (url.pathname === `/api/session/${match.id}`) return json({ data: match })
      if (url.pathname.endsWith("/message"))
        return json({ data: (input.messages[match.id] ?? []).toReversed(), cursor: {} })
      if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/permission")) return json({ data: [] })
    },
  })
}

type Setup = Awaited<ReturnType<typeof open>>

async function click(setup: Setup, label: string) {
  const lines = setup.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(label))
  setup.renderer.clearSelection()
  await setup.mockMouse.click(lines[y].indexOf(label) + 2, y)
}

test("shows each message the user did not type as a collapsed bar and a typed message in full", async () => {
  await using setup = await open({ sessionID: session.id, messages: { [session.id]: messages } })
  await setup.ready
  const frame = await setup.waitForFrame((frame) => frame.includes("+ Task from parent agent"))
  expect(frame).toContain("Fix the timeline setting")
  expect(frame).toContain("+ Fork notice")
  expect(frame).toContain("+ Skill review")
  expect(frame).toContain("+ Instructions updated: AGENTS.md")
  expect(frame).not.toContain("body")
  expect(frame).not.toContain("Find where the setting is stored")
})

test("shows a message the user typed in a subagent session in full", async () => {
  const typed = { id: "typed", type: "user", text: "Also check the tests", time: { created: 3 } }
  await using setup = await open({ sessionID: child.id, messages: { [child.id]: [task, answer("Done"), typed] } })
  await setup.ready
  const frame = await setup.waitForFrame((frame) => frame.includes("Also check the tests"))
  expect(frame).toContain("+ Task from parent agent")
})

test("shows a follow-up prompt from the parent agent as a collapsed bar", async () => {
  const followUp = {
    id: "follow-up",
    type: "user",
    text: "Now check where the setting is read",
    metadata: SUBAGENT_TASK_METADATA,
    time: { created: 3 },
  }
  await using setup = await open({ sessionID: child.id, messages: { [child.id]: [answer("Done"), followUp] } })
  await setup.ready
  const frame = await setup.waitForFrame((frame) => frame.includes("+ Task from parent agent"))
  expect(frame).not.toContain("Now check where the setting is read")
})

test("opens a collapsed bar to its full text on click and closes it on the next click", async () => {
  await using setup = await open({ sessionID: session.id, messages: { [session.id]: messages } })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("+ Fork notice"))
  await click(setup, "+ Fork notice")
  expect(await setup.waitForFrame((frame) => frame.includes("- Fork notice"))).toContain("Fork notice body")
  await click(setup, "- Fork notice")
  expect(await setup.waitForFrame((frame) => frame.includes("+ Fork notice"))).not.toContain("Fork notice body")
})

test("toggles the nearest collapsed bar from the keyboard", async () => {
  await using setup = await open({ sessionID: child.id, messages: { [child.id]: [task, answer("Done")] } })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("+ Task from parent agent"))
  setup.mockInput.pressKey("o", { ctrl: true, shift: true })
  expect(await setup.waitForFrame((frame) => frame.includes("- Task from parent agent"))).toContain(
    "Find where the setting is stored",
  )
})

test("keeps a bar open after leaving its session and coming back", async () => {
  await using setup = await open({
    sessionID: child.id,
    messages: { [session.id]: parentMessages, [child.id]: [task, answer("Done")] },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("+ Task from parent agent"))
  await click(setup, "+ Task from parent agent")
  await setup.waitForFrame((frame) => frame.includes("- Task from parent agent"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("General finished"))
  await click(setup, "General finished")
  expect(await setup.waitForFrame((frame) => frame.includes("- Task from parent agent"))).toContain(
    "Find where the setting is stored",
  )
})

test("opening a subagent from its parent lands on its last answer", async () => {
  await using setup = await open({
    sessionID: session.id,
    messages: { [session.id]: parentMessages, [child.id]: [task, longAnswer] },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("General finished"))
  await click(setup, "General finished")
  const frame = await waitForHighlightedFrame(setup, (frame) => frame.includes("Answer start"))
  expect(frame).not.toContain("Answer line 29")
})

test("opening a subagent session directly lands at the end of its transcript", async () => {
  await using setup = await open({ sessionID: child.id, messages: { [child.id]: [task, longAnswer] } })
  await setup.ready
  const frame = await waitForHighlightedFrame(setup, (frame) => frame.includes("Answer line 29"))
  expect(frame).not.toContain("Answer start")
})
