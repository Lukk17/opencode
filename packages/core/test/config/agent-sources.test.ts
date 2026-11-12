import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { ConfigSourcePath } from "@opencode/core/config/source-path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Flag } from "@opencode/core/flag"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { configLayer, globalDirectory, projectHost, sourceDiagnostics, write } from "../fixture/config-layer"
import { withTempDir } from "../fixture/tmpdir"
import { eventually } from "../lib/eventually"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])),
    Flag.testLayer(),
  ),
)
const flag = { experimental: { config_sources: true } }

describe("ConfigAgentPlugin sources", () => {
  for (const enabled of [false, true])
    it.live(
      `${enabled ? "loads" : "ignores"} agents from home and project .agents roots and listed directories when the flag is ${enabled ? "on" : "off"}`,
      () =>
        withTempDir((tmp) =>
          Effect.gen(function* () {
            const { home, project } = yield* roots(tmp.path, {
              ...(enabled ? flag : {}),
              sources: { agents: ["./listed"] },
            })
            const homeAgents = path.join(home, ".agents")
            const projectAgents = path.join(project, ".agents")
            yield* write(path.join(globalDirectory(home), "agents", "over-global.md"), "Global directory.")
            yield* write(path.join(homeAgents, "agents", "over-global.md"), "Home root.")
            yield* write(path.join(homeAgents, "agent", "over-home.md"), "Home root.")
            yield* write(path.join(projectAgents, "agents", "over-home.md"), "Project root.")
            yield* write(path.join(projectAgents, "agents", "over-project.md"), "Project root.")
            yield* write(path.join(project, ".opencode", "agents", "over-project.md"), "Project directory.")
            yield* write(path.join(projectAgents, "agents", "team", "helper.md"), "Help the team.")
            yield* write(path.join(projectAgents, "modes", "planner.md"), "Make a plan.")
            yield* write(path.join(project, "listed", "listed-agent.md"), "Listed.")

            const agents = yield* start(project, home)

            for (const [id, system] of Object.entries({
              "over-global": enabled ? "Home root." : "Global directory.",
              "over-home": enabled ? "Project root." : undefined,
              "over-project": "Project directory.",
              "team/helper": enabled ? "Help the team." : undefined,
              planner: enabled ? "Make a plan." : undefined,
              "listed-agent": enabled ? "Listed." : undefined,
            }))
              expect((yield* agents.get(Agent.ID.make(id)))?.system).toBe(system)
          }),
        ),
    )

  for (const [name, global, loads] of [
    ["no config sets sources", {}, false],
    ["only the global config sets sources", { sources: {} }, true],
  ] as const)
    it.live(`${loads ? "loads" : "skips"} .agents agents when ${name}`, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const { home, project } = yield* roots(tmp.path, flag)
          yield* write(path.join(globalDirectory(home), "opencode.json"), global)
          yield* write(path.join(home, ".agents", "agents", "home-agent.md"), "Home root.")
          yield* write(path.join(project, ".agents", "agents", "project-agent.md"), "Project root.")

          const agents = yield* start(project, home)

          for (const id of ["home-agent", "project-agent"])
            expect((yield* agents.get(Agent.ID.make(id))) !== undefined).toBe(loads)
        }),
      ),
    )

  it.live("names listed agents by their path inside the listed directory", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* roots(tmp.path, { ...flag, sources: { agents: ["./team-agents"] } })
        yield* write(path.join(globalDirectory(home), "opencode.json"), { sources: { agents: ["~/shared-agents"] } })
        yield* write(path.join(project, "team-agents", "reviewer.md"), "Review.")
        yield* write(path.join(project, "team-agents", "nested", "deep.md"), "Go deep.")
        yield* write(path.join(project, "team-agents", "agents", "kept-prefix.md"), "Keep the prefix.")
        yield* write(path.join(project, "team-agents", "notes.txt"), "Not an agent.")
        yield* write(
          path.join(home, "shared-agents", "helper.md"),
          "---\ndescription: Shared helper\nmode: subagent\n---\nHelp.",
        )

        const agents = yield* start(project, home)

        expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review." })
        expect(yield* agents.get(Agent.ID.make("nested/deep"))).toMatchObject({ system: "Go deep." })
        expect(yield* agents.get(Agent.ID.make("agents/kept-prefix"))).toMatchObject({ system: "Keep the prefix." })
        expect(yield* agents.get(Agent.ID.make("helper"))).toMatchObject({
          system: "Help.",
          description: "Shared helper",
          mode: "subagent",
        })
      }),
    ),
  )

  it.live("lets nearer config win over listed agents and loads each listed directory before its document", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* roots(tmp.path, {
          ...flag,
          sources: { agents: ["./listed"] },
          agents: { same: { description: "Project JSON" } },
        })
        yield* write(path.join(globalDirectory(home), "opencode.json"), { sources: { agents: ["./listed"] } })
        yield* write(path.join(globalDirectory(home), "listed", "same.md"), "Global listed.")
        yield* write(path.join(globalDirectory(home), "listed", "global-only.md"), "Global only.")
        yield* write(path.join(project, "listed", "same.md"), "---\ndescription: Listed file\n---\nProject listed.")

        const agents = yield* start(project, home)

        expect(yield* agents.get(Agent.ID.make("same"))).toMatchObject({
          system: "Project listed.",
          description: "Project JSON",
        })
        expect(yield* agents.get(Agent.ID.make("global-only"))).toMatchObject({ system: "Global only." })
      }),
    ),
  )

  it.live("loads only listed agents and config documents when load_only_selected is set", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* roots(tmp.path, {
          ...flag,
          sources: { agents: ["./listed"], load_only_selected: true },
          agents: { configured: { description: "From JSON" } },
        })
        yield* write(path.join(globalDirectory(home), "agents", "global-agent.md"), "Global directory.")
        yield* write(path.join(home, ".agents", "agents", "home-agent.md"), "Home root.")
        yield* write(path.join(project, ".agents", "agents", "project-agent.md"), "Project root.")
        yield* write(path.join(project, ".opencode", "agents", "opencode-agent.md"), "Project directory.")
        yield* write(path.join(project, "listed", "listed-agent.md"), "Listed.")
        const system = path.join(tmp.path, "system")
        yield* write(path.join(system, "agents", "managed-agent.md"), "Managed.")

        const agents = yield* start(project, home, { system })

        expect(yield* agents.get(Agent.ID.make("listed-agent"))).toMatchObject({ system: "Listed." })
        expect(yield* agents.get(Agent.ID.make("configured"))).toMatchObject({ description: "From JSON" })
        expect(yield* agents.get(Agent.ID.make("managed-agent"))).toMatchObject({ system: "Managed." })
        for (const name of ["global-agent", "home-agent", "project-agent", "opencode-agent"])
          expect(yield* agents.get(Agent.ID.make(name))).toBeUndefined()
      }),
    ),
  )

  it.live("rebuilds agents when a file changes in a listed directory outside config directories", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const listed = path.join(tmp.path, "project", "listed")
        const { home, project } = yield* roots(tmp.path, { ...flag, sources: { agents: [listed] } })
        yield* write(path.join(listed, "reviewer.md"), "Review first.")
        yield* Effect.gen(function* () {
          const agents = yield* Agent.Service
          const watcher = yield* Watcher.Test
          yield* ConfigAgentPlugin.Plugin.effect(projectHost(agents, project))
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review first." })
          expect(yield* watcher.subscriptions()).toContainEqual({
            path: listed,
            type: "directory",
            ignore: FSUtil.ignoreGlobs.toSorted(),
          })

          yield* write(path.join(listed, "reviewer.md"), "Review again.")
          yield* write(path.join(listed, "added.md"), "Added.")
          yield* watcher.emit({ type: "update", path: path.join(listed, "reviewer.md") })
          yield* eventually(agents.get(Agent.ID.make("added")), (agent) => agent !== undefined)
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review again." })
        }).pipe(Effect.provide(configLayer({ directory: project, home })))
      }),
    ),
  )

  it.live("picks up a listed directory created after start and warns once while it is missing", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const listed = path.join(tmp.path, "project", "later", "agents-listed")
        const { home, project } = yield* roots(tmp.path, { ...flag, sources: { agents: [listed] } })
        yield* write(path.join(project, "later", ".keep"), "")
        const warnings: unknown[] = []
        const logger = Logger.map(Logger.formatStructured, (entry) => {
          if (Array.isArray(entry.message) && entry.message[0] === "listed source directory not found")
            warnings.push(entry.message[1])
        })
        yield* Effect.gen(function* () {
          const agents = yield* Agent.Service
          const watcher = yield* Watcher.Test
          const pluginHost = projectHost(agents, project)
          const reloads = { count: 0 }
          yield* ConfigAgentPlugin.Plugin.effect({
            ...pluginHost,
            agent: {
              ...pluginHost.agent,
              reload: () => pluginHost.agent.reload().pipe(Effect.tap(() => Effect.sync(() => reloads.count++))),
            },
          })
          expect(yield* watcher.subscriptions()).toContainEqual({
            path: path.dirname(listed),
            type: "entries",
            names: [path.basename(listed)],
          })
          yield* watcher.emit({ type: "create", path: listed })
          yield* eventually(
            Effect.sync(() => reloads.count),
            (count) => count === 1,
          )

          yield* write(path.join(listed, "late.md"), "Listed late.")
          yield* watcher.emit({ type: "create", path: listed })
          yield* eventually(agents.get(Agent.ID.make("late")), (agent) => agent !== undefined)
          expect(yield* watcher.subscriptions()).toContainEqual({
            path: listed,
            type: "directory",
            ignore: FSUtil.ignoreGlobs.toSorted(),
          })
        }).pipe(Effect.provide(configLayer({ directory: project, home })), Effect.provide(Logger.layer([logger])))
        expect(warnings).toEqual([{ kind: "agents", directory: listed }])
      }),
    ),
  )

  it.live("rebuilds agents when an agents folder is added to a .agents root", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* roots(tmp.path, { ...flag, sources: {} })
        const root = path.join(project, ".agents")
        yield* Effect.gen(function* () {
          const agents = yield* Agent.Service
          const watcher = yield* Watcher.Test
          yield* ConfigAgentPlugin.Plugin.effect(projectHost(agents, project))
          expect(yield* watcher.subscriptions()).toContainEqual({
            path: root,
            type: "entries",
            names: ["agent", "agents", "mode", "modes"],
          })

          yield* write(path.join(root, "agents", "late.md"), "Arrived late.")
          yield* watcher.emit({ type: "create", path: path.join(root, "agents") })
          yield* eventually(agents.get(Agent.ID.make("late")), (agent) => agent !== undefined)
          expect(yield* agents.get(Agent.ID.make("late"))).toMatchObject({ system: "Arrived late." })
        }).pipe(Effect.provide(configLayer({ directory: project, home })))
      }),
    ),
  )

  it.live("loads at most the limit of files from one listed directory and reports the rest", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* roots(tmp.path, { ...flag, sources: { agents: ["./many"] } })
        const names = Array.from({ length: ConfigSourcePath.maxFiles + 1 }, (_, index) =>
          `file-${index}`.padStart(9, "0"),
        )
        yield* Effect.forEach(names, (name) => write(path.join(project, "many", `${name}.md`), "Many."))
        const logs = sourceDiagnostics()
        const agents = yield* start(project, home).pipe(Effect.provide(Logger.layer([logs.logger])))

        expect(yield* agents.get(Agent.ID.make(names[ConfigSourcePath.maxFiles - 1]))).toBeDefined()
        expect(yield* agents.get(Agent.ID.make(names[ConfigSourcePath.maxFiles]))).toBeUndefined()
        expect(logs.output).toEqual([
          {
            source: path.join(project, "opencode.json"),
            path: "$.sources.agents",
            kind: "truncated",
            action: `read only the first ${ConfigSourcePath.maxFiles} files and folders in ${path.join(project, "many")}, list a smaller folder`,
          },
        ])
      }),
    ),
  )
})

const start = Effect.fnUntraced(function* (project: string, home: string, options?: Config.Options) {
  const agents = yield* Agent.Service
  yield* ConfigAgentPlugin.Plugin.effect(projectHost(agents, project)).pipe(
    Effect.provide(configLayer({ directory: project, home, options })),
  )
  return agents
})

const roots = Effect.fnUntraced(function* (root: string, projectConfig: object) {
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  yield* Effect.promise(() =>
    Promise.all([
      fs.mkdir(path.join(home, ".agents"), { recursive: true }),
      fs.mkdir(path.join(project, ".agents"), { recursive: true }),
      fs.mkdir(globalDirectory(home), { recursive: true }),
    ]),
  )
  yield* write(path.join(project, "opencode.json"), projectConfig)
  return { home, project }
})
