import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal } from "solid-js"
import { CollapsedMessage } from "../../../routes/session/collapsed-message"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

const task = [
  "You are a subagent spawned by another session.",
  "Find where the timeline setting is stored and report the file and the default value.",
].join("\n")

function CollapsedMessageStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const [open, setOpen] = createSignal(false)
  const [long, setLong] = createSignal(false)
  const label = () =>
    long()
      ? "Instructions updated: AGENTS.md, packages/tui/AGENTS.md, packages/session-ui/AGENTS.md, services/site/AGENTS.md"
      : "Task from parent agent"

  props.context.keymap.layer(() => ({
    commands: [
      { bind: "c", title: "Collapse", group: "Storybook", run: () => setOpen(false) },
      { bind: "e", title: "Expand", group: "Storybook", run: () => setOpen(true) },
      { bind: "t", title: "Toggle", group: "Storybook", run: () => setOpen(!open()) },
      { bind: "l", title: "Long label", group: "Storybook", run: () => setLong(!long()) },
      {
        bind: "r",
        title: "Reset",
        group: "Storybook",
        run: () => {
          setOpen(false)
          setLong(false)
        },
      },
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={props.context.theme.background.base}
    >
      <box paddingTop={1} flexGrow={1}>
        <CollapsedMessage label={label()} text={task} open={open()} onOpenChange={setOpen} />
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / collapsed message"
        status={`${open() ? "expanded" : "collapsed"} · ${long() ? "long" : "short"} label`}
        controls={[
          { shortcut: "c", label: "collapsed" },
          { shortcut: "e", label: "expanded" },
          { shortcut: "t", label: "toggle, as session.message.toggle does" },
          { shortcut: "l", label: "long label" },
          { shortcut: "r", label: "reset" },
          { shortcut: "click", label: "toggle" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const collapsedMessageStory: Story = {
  id: "collapsed-message",
  title: "Collapsed message",
  render: (context) => <CollapsedMessageStory context={context} />,
}
