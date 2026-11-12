import { lazy, onCleanup, Show, Suspense } from "solid-js"
import {
  createKeyed,
  MenuItem,
  Panel,
  usePanel,
  type ClosedPanelTab,
  type MountedSession,
  type PanelTab,
  type Plugin,
} from "@opencode/plugin/gui"
import { onIdle } from "@opencode/plugin/gui/builtin"
import type definition from "./index"
import { autoOpen, experimentalSettings, subagentTree } from "./model"

/**
 * The Agents side panel: the routed session's todo list and every subagent below it. It opens by itself, in the
 * background, once per session, the first time a subagent runs or when a subagent's chat opens in a tab whose main
 * chat has it open; the + menu opens it any time.
 */
const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const SubagentsTab = lazy(() => import("./panel"))
  onCleanup(onIdle(() => void SubagentsTab.preload()))

  const key = `${ctx.id}:main`

  const tab: PanelTab = {
    id: "main",
    get title() {
      return ctx.t("tab.title")
    },
  }

  const tree = (session: MountedSession) =>
    subagentTree(
      session.id,
      session.server.data.session.family(session.id).flatMap((id) => session.server.data.session.get(id) ?? []),
    )

  ctx.add(Panel, {
    id: "main",
    region: "side",
    mobile: {
      get title() {
        return ctx.t("mobile.title")
      },
      order: 45,
      kind: "menu",
      icon: "task",
    },
    list: (input) => (input.open.includes("main") ? [tab] : []),
    closed: (): ClosedPanelTab => ({ icon: "task" }),
    render: (props) => {
      const panel = usePanel()

      return (
        <Show
          when={panel.placement() !== "mobile"}
          fallback={
            <Suspense>
              <SubagentsTab session={props.session} />
            </Suspense>
          }
        >
          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
            <Suspense>
              <SubagentsTab session={props.session} />
            </Suspense>
          </div>
        </Show>
      )
    },
  })

  ctx.add(MenuItem, (): MenuItem | undefined => {
    const session = ctx.sessions.current()

    if (!session || ctx.layout.narrow()) return undefined
    const count = tree(session).length

    return {
      menu: "session.panel",
      id: "open",
      title: ctx.t("tab.title"),
      opened: ctx.layout.state(key, session) !== "closed",
      description: count > 0 ? ctx.plural("menu.count", count) : undefined,
      icon: "task",
      order: 30,
      run: () => ctx.layout.open(key, session, { tab: "select" }),
    }
  })

  createKeyed(
    () => {
      const session = ctx.sessions.current()

      if (!session) return
      const running = tree(session).some((node) => session.server.data.session.status(node.id) === "running")
      const main = ctx.tabs.list().find((tab) => tab.key === session.tab)?.session
      const mainOpen = main !== undefined && main.id !== session.id && ctx.layout.state(key, main) !== "closed"
      const config = session.server.data.location.config.list({ directory: session.directory })
      const enabled = config !== undefined && experimentalSettings(config)?.agents_panel_auto_open !== false

      return autoOpen({ enabled, opened: ctx.stores.auto(session).value?.opened, running, mainOpen }) && session
    },
    (session) => {
      ctx.stores.auto(session).set({ opened: true })
      ctx.layout.open(key, session, { tab: "select", background: true })
    },
  )
}

export default setup
