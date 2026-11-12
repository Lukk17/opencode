import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Logger, Stream } from "effect"
import { App } from "@opencode/core/app"
import { Config } from "@opencode/core/config"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { ConfigSourcePath } from "@opencode/core/config/source-path"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Flag } from "@opencode/core/flag"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { configLayer, globalDirectory, sourceDiagnostics, write } from "../fixture/config-layer"
import { location } from "../fixture/location"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const flag = { experimental: { config_sources: true } }

describe("ConfigPluginSource sources", () => {
  for (const enabled of [false, true])
    it.live(
      `${enabled ? "loads" : "ignores"} the direct children of listed directories at the position of their document when the flag is ${enabled ? "on" : "off"}`,
      () =>
        withTempDir((tmp) =>
          Effect.gen(function* () {
            const { home, project } = yield* plugins(tmp.path, {
              ...(enabled ? flag : {}),
              sources: { plugins: ["./listed"] },
            })
            yield* write(path.join(globalDirectory(home), "plugins", "global.ts"))
            yield* write(path.join(globalDirectory(home), "opencode.json"), {
              sources: { plugins: ["~/shared-plugins"] },
            })

            const targets = yield* operations(project, home)

            expect(targets).toEqual([
              ...(enabled ? [path.join(home, "shared-plugins", "shared.ts")] : []),
              path.join(globalDirectory(home), "plugins", "global.ts"),
              ...(enabled ? ["alpha.ts", "beta.js", "folder"].map((name) => path.join(project, "listed", name)) : []),
              path.join(project, ".opencode", "plugins", "local.ts"),
            ])
          }),
        ),
    )

  it.live("skips the plugin folders of config directories except managed ones when load_only_selected is set", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* plugins(tmp.path, {
          ...flag,
          plugins: ["./explicit"],
          sources: { plugins: ["./listed"], load_only_selected: true },
        })
        yield* write(path.join(globalDirectory(home), "plugins", "global.ts"))
        yield* write(path.join(project, "explicit", "index.ts"))
        const system = path.join(tmp.path, "system")
        yield* write(path.join(system, "plugins", "managed.ts"))

        const targets = yield* operations(project, home, { system })

        expect(targets).toEqual([
          path.join(project, "listed", "alpha.ts"),
          path.join(project, "listed", "beta.js"),
          path.join(project, "listed", "folder"),
          path.join(system, "plugins", "managed.ts"),
          path.join(project, "explicit"),
        ])
      }),
    ),
  )

  it.live("rejects plugin folders that project config lists outside the project", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* plugins(tmp.path, {
          ...flag,
          sources: { plugins: ["./listed", "~/shared-plugins"] },
        })
        const logs = sourceDiagnostics()

        const targets = yield* operations(project, home).pipe(Effect.provide(Logger.layer([logs.logger])))

        expect(targets).toContain(path.join(project, "listed", "alpha.ts"))
        expect(targets).not.toContain(path.join(home, "shared-plugins", "shared.ts"))
        expect(logs.output).toEqual([
          {
            source: path.join(project, "opencode.json"),
            path: "$.sources.plugins",
            kind: "rejected",
            action: `ignored ${path.join(home, "shared-plugins")} because it ${ConfigSourcePath.reasons.outside_project}`,
          },
        ])
      }),
    ),
  )

  it.live("watches listed directories and reports their changes", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const listed = path.join(tmp.path, "project", "listed-outside")
        const { home, project } = yield* plugins(tmp.path, { ...flag, sources: { plugins: [listed] } })
        yield* write(path.join(listed, "outside.ts"))
        yield* Effect.gen(function* () {
          const source = yield* ConfigPluginSource.Service
          const watcher = yield* Watcher.Test
          const changed = yield* source
            .changes()
            .pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped({ startImmediately: true }))

          expect((yield* source.operations()).map((operation) => operation.target)).toContain(
            path.join(listed, "outside.ts"),
          )
          expect(yield* watcher.subscriptions()).toContainEqual({ path: listed, type: "entries" })

          yield* write(path.join(listed, "added.ts"))
          yield* watcher.emit({ type: "create", path: path.join(listed, "added.ts") })
          yield* Fiber.join(changed).pipe(Effect.timeout("5 seconds"))
          expect((yield* source.operations()).map((operation) => operation.target)).toContain(
            path.join(listed, "added.ts"),
          )
        }).pipe(Effect.provide(sourceLayer(project, home)))
      }),
    ),
  )

  it.live("reports a change to the package.json of a loaded plugin folder", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* plugins(tmp.path, { ...flag, sources: { plugins: ["./listed"] } })
        const folder = path.join(project, "listed", "folder")
        const manifest = path.join(folder, "package.json")
        yield* write(manifest, { name: "folder" })
        yield* Effect.gen(function* () {
          const source = yield* ConfigPluginSource.Service
          const watcher = yield* Watcher.Test
          yield* source.operations()
          expect(yield* watcher.subscriptions()).toContainEqual({
            path: folder,
            type: "entries",
            names: ["package.json"],
          })
          const changed = yield* source
            .changes()
            .pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped({ startImmediately: true }))

          yield* write(manifest, { name: "folder", version: "2.0.0" })
          yield* watcher.emit({ type: "update", path: manifest })
          yield* Fiber.join(changed).pipe(Effect.timeout("5 seconds"))
        }).pipe(Effect.provide(sourceLayer(project, home)))
      }),
    ),
  )
})

function sourceLayer(project: string, home: string, options?: Config.Options) {
  return ConfigPluginSource.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Flag.layer.pipe(Layer.provide(App.layer())),
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
      ),
    ),
    Layer.provideMerge(configLayer({ directory: project, home, options })),
  )
}

function operations(project: string, home: string, options?: Config.Options) {
  return ConfigPluginSource.Service.use((source) => source.operations()).pipe(
    Effect.map((items) => items.map((operation) => operation.target)),
    Effect.scoped,
    Effect.provide(sourceLayer(project, home, options)),
  )
}

const plugins = Effect.fnUntraced(function* (root: string, projectConfig: object) {
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  yield* write(path.join(project, ".opencode", "plugins", "local.ts"))
  yield* write(path.join(project, "listed", "alpha.ts"))
  yield* write(path.join(project, "listed", "beta.js"))
  yield* write(path.join(project, "listed", "folder", "index.ts"))
  yield* write(path.join(project, "listed", "notes.md"))
  yield* write(path.join(home, "shared-plugins", "shared.ts"))
  yield* Effect.promise(() => fs.mkdir(globalDirectory(home), { recursive: true }))
  yield* write(path.join(project, "opencode.json"), projectConfig)
  return { home, project }
})
