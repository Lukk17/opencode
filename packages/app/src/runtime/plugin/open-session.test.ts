import { expect, test } from "bun:test"
import { ServerConnection } from "@/runtime/server/registry"
import { sessionHref } from "@/shell/routes/session"
import { findSessionTab, type SessionTab, type Tab } from "@/shell/tabs/tabs"
import { openSessionFrom } from "./open-session"

test("opens a session inside the tab showing `from`", () => {
  const server = ServerConnection.Key.make("https://example.com:4096")
  const parent: SessionTab = { type: "session", server, sessionId: "parent" }
  const store: Tab[] = [{ type: "session", server, sessionId: "other" }, parent]
  const routes: [SessionTab, string, string | undefined][] = []
  const hrefs: (string | number)[] = []

  openSessionFrom(
    {
      sessionTab: (key, sessionID) => findSessionTab(store, key, sessionID),
      rememberSessionRoute: (tab, sessionId, parentId) => void routes.push([tab, sessionId, parentId]),
    },
    (to: string | number) => void hrefs.push(to),
    { server, from: "parent", id: "child", parentID: "parent" },
  )

  expect(routes).toEqual([[parent, "child", "parent"]])
  expect(hrefs).toEqual([sessionHref(server, "child")])
})
