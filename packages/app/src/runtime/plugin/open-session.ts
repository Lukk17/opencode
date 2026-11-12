import type { Navigator } from "@solidjs/router"
import type { ServerConnection } from "@/runtime/server/registry"
import { sessionHref } from "@/shell/routes/session"
import type { SessionTab, Tab } from "@/shell/tabs/tabs"

/** `Tabs.open` with `from`: shows the session in the tab that shows `from`, which records its parent for Esc. */
export function openSessionFrom(
  tabs: {
    sessionTab(server: ServerConnection.Key, sessionID: string): Tab | undefined
    rememberSessionRoute(tab: SessionTab, sessionId: string, parentId?: string): void
  },
  navigate: Navigator,
  input: { server: ServerConnection.Key; from: string; id: string; parentID?: string },
) {
  const tab = tabs.sessionTab(input.server, input.from)

  if (tab?.type === "session") tabs.rememberSessionRoute(tab, input.id, input.parentID)
  navigate(sessionHref(input.server, input.id))
}
