/** The metadata a parent agent's prompts to a subagent carry, the first task and follow-ups alike. */
export const SUBAGENT_TASK_METADATA = { source: "parent-agent" } as const

/** Whether a user message is a prompt from a parent agent, rather than input the user typed. */
export function isSubagentTask(metadata: Record<string, unknown> | undefined) {
  return metadata?.source === SUBAGENT_TASK_METADATA.source
}
