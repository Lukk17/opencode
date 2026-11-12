import { Show } from "solid-js"
import type { BoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import type { SessionMessageInfo } from "@opencode/client"
import { isSubagentTask } from "@opencode/util/subagent-task"
import { useTheme } from "../../context/theme"

/** The bar label and full text of a message the user did not type, or undefined for any other message. */
export function collapsedMessage(message: SessionMessageInfo) {
  if (message.type === "user")
    return isSubagentTask(message.metadata) ? { label: "Task from parent agent", text: message.text } : undefined
  if (message.type === "skill") return { label: `Skill ${message.name}`, text: message.text }
  if (message.type === "system") return { label: message.description || "Instructions updated", text: message.text }
  if (message.type !== "synthetic") return
  const source = message.metadata?.source
  if (source === "subagent" || source === "shell") return
  return { label: message.description || "Note from opencode", text: message.text }
}

/** A message the user did not type: one line with a short label that a click opens to its full text and closes again. */
export function CollapsedMessage(props: {
  label: string
  text: string
  open: boolean
  /** Receives the bar, which keeps its screen row while the text opens or closes. */
  onOpenChange: (open: boolean, bar: BoxRenderable) => void
}) {
  const theme = useTheme()
  const renderer = useRenderer()
  let bar!: BoxRenderable
  return (
    <box paddingLeft={3} flexShrink={0}>
      <box
        ref={bar}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          props.onOpenChange(!props.open, bar)
        }}
      >
        <text fg={theme.text.muted} wrapMode="none" truncate>
          {`${props.open ? "-" : "+"} ${props.label}`}
        </text>
      </box>
      <Show when={props.open}>
        <box paddingLeft={2}>
          <text fg={theme.text.muted}>{props.text}</text>
        </box>
      </Show>
    </box>
  )
}
