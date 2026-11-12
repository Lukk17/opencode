import { SUBAGENT_TASK_METADATA } from "@opencode/util/subagent-task"
import { createEffect, createSignal } from "solid-js"
import type { SessionDocument } from "../document"
import { CURRENT_SESSION_ID, STORY_MODEL, STORY_TIME } from "../storybook/current-session-fixtures"
import { CurrentSessionProviders } from "../storybook/current-session-story"
import { SessionTimeline } from "../timeline/session-timeline"
import { CollapsedMessage } from "./collapsed-message"

export default {
  title: "OpenCode/Conversation/Collapsed message",
  id: "current-session-collapsed-message",
  component: CollapsedMessage,
  args: { open: false },
  argTypes: { open: { control: "boolean" } },
}

const task = [
  "You are a subagent spawned by another session.",
  "Find where the timeline setting is stored and report the file and the default value.",
].join("\n")

export const Bar = {
  render: (args: { open: boolean }) => {
    const [open, setOpen] = createSignal(args.open)
    createEffect(() => setOpen(args.open))

    return (
      <section class="mx-auto w-full max-w-[720px] bg-v2-background-bg-base p-6">
        <CollapsedMessage label="Task from parent agent" text={task} open={open()} onOpenChange={setOpen} />
      </section>
    )
  },
}

const parent = {
  sessionID: CURRENT_SESSION_ID,
  status: { type: "idle" },
  diffs: [],
  messages: [
    {
      id: "msg_collapsed_typed",
      type: "user",
      text: "Fix the timeline setting that resets after a restart.",
      metadata: { agent: "build", model: STORY_MODEL },
      time: { created: STORY_TIME },
    },
    {
      id: "msg_collapsed_described",
      type: "synthetic",
      text: "<fork-notice>This session is a fork. Files are shared with the original.</fork-notice>",
      description: "Fork notice",
      time: { created: STORY_TIME + 1 },
    },
    {
      id: "msg_collapsed_skill",
      type: "skill",
      skill: "review",
      name: "Review",
      text: "Review the change for correctness before you report back.",
      time: { created: STORY_TIME + 3 },
    },
    {
      id: "msg_collapsed_system",
      type: "system",
      text: "AGENTS.md changed: run tests from the package directory.",
      description: "Instructions updated: AGENTS.md",
      time: { created: STORY_TIME + 4 },
    },
  ],
} satisfies SessionDocument

const child = {
  sessionID: "session_child_review",
  status: { type: "idle" },
  diffs: [],
  messages: [
    {
      id: "msg_collapsed_task",
      type: "user",
      text: task,
      metadata: { ...SUBAGENT_TASK_METADATA, agent: "explore", model: STORY_MODEL },
      time: { created: STORY_TIME + 10 },
    },
    {
      id: "msg_collapsed_answer",
      type: "assistant",
      agent: "explore",
      model: STORY_MODEL,
      content: [{ type: "text", text: "The setting lives in `src/settings/model.tsx` and defaults to Compact." }],
      time: { created: STORY_TIME + 11, completed: STORY_TIME + 12 },
    },
    {
      id: "msg_collapsed_typed_child",
      type: "user",
      text: "Also check where the setting is read.",
      metadata: { agent: "explore", model: STORY_MODEL },
      time: { created: STORY_TIME + 13 },
    },
  ],
} satisfies SessionDocument

export const Timeline = {
  render: () => (
    <section class="mx-auto flex w-full max-w-[720px] flex-col gap-6 bg-v2-background-bg-base p-6">
      <div data-story-session="parent">
        <CurrentSessionProviders document={parent}>
          <SessionTimeline document={parent} />
        </CurrentSessionProviders>
      </div>
      <div data-story-session="child">
        <CurrentSessionProviders document={child}>
          <SessionTimeline document={child} />
        </CurrentSessionProviders>
      </div>
    </section>
  ),
}
