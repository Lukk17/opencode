export * as ConfigPluginSource from "./source.js"

import { Document, type Entry } from "@opencode/schema/config"
import { ConfigPlugin } from "@opencode/schema/config/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Host } from "@opencode/plugin/host"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, FiberMap, Layer, Option, PubSub, Scope, Stream } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { Flag } from "../../flag.js"
import { Location } from "../../location.js"
import { PluginSourceDirectory } from "../../plugin/source-directory.js"
import { ConfigSourcePath } from "../source-path.js"
import { ConfigSourceWatches } from "../source-watches.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export type Operation =
  | {
      readonly type: "add"
      readonly target: string
      readonly options: Record<string, unknown>
      readonly mtime?: number
    }
  | {
      readonly type: "remove"
      readonly target: string
    }

export interface Interface {
  readonly operations: () => Effect.Effect<readonly Operation[], never, Scope.Scope>
  readonly changes: () => Stream.Stream<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ConfigPluginSource") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const watcher = yield* Watcher.Service
    const flags = yield* Flag.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const configuredChanges = yield* PubSub.unbounded<void>()
    const notify = PubSub.publish(configuredChanges, undefined).pipe(Effect.asVoid)
    const watched = new Set<string>()
    const listedWatches = yield* FiberMap.make<string>()
    const packageWatches = yield* FiberMap.make<string>()
    const reported = { keys: new Set<string>() }

    // Configured local plugins and listed sources.plugins directories can live
    // outside config roots, where the config change feed cannot see them;
    // watch those targets directly.
    // Configured plugin watches start on first sighting and are never torn down
    // individually: a stale watch after a config edit costs one deduped fs
    // handle and a no-op activation, and every watch dies with this layer's
    // scope.
    const watchConfiguredSources = Effect.fn("ConfigPluginSource.watchConfiguredSources")(function* (
      entries: readonly Entry[],
      listed: readonly string[],
      operations: readonly Operation[],
    ) {
      for (const operation of operations) {
        if (operation.type !== "add" || !path.isAbsolute(operation.target)) continue
        if (listed.some((directory) => FSUtil.contains(directory, operation.target))) continue
        if (watched.has(operation.target)) continue
        // The config change feed already covers {plugin,plugins} directories.
        if (ConfigEntryObserver.isDirectorySource(entries, operation.target, PluginSourceDirectory.names)) continue
        watched.add(operation.target)
        const updates = yield* watcher.subscribe({
          path: operation.target,
          type: (yield* fs.isDir(operation.target)) ? "directory" : "file",
        })
        yield* updates.pipe(
          Stream.runForEach(() => PubSub.publish(configuredChanges, undefined)),
          Effect.catchCause((cause) =>
            Effect.logError("configured plugin watch failed", { target: operation.target, cause }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
      }
    })

    const watchListed = Effect.fn("ConfigPluginSource.watchListed")(function* (
      entries: readonly Entry[],
      listed: readonly string[],
    ) {
      const targets = new Map<string, Watcher.WatchInput>()
      for (const target of listed) {
        if (ConfigEntryObserver.isDirectorySource(entries, target, PluginSourceDirectory.names)) continue
        const type = (yield* fs.isDir(target)) ? "entries" : "file"
        targets.set(`${type}:${target}`, { path: target, type })
      }
      yield* ConfigSourceWatches.sync(watcher, listedWatches, targets, notify)
    })

    const watchPackages = Effect.fn("ConfigPluginSource.watchPackages")(function* (
      entries: readonly Entry[],
      children: readonly string[],
    ) {
      const folders = yield* Effect.filter(
        children.filter((child) => !ConfigEntryObserver.isDirectorySource(entries, child, PluginSourceDirectory.names)),
        fs.isDir,
      )
      yield* ConfigSourceWatches.sync(
        watcher,
        packageWatches,
        new Map(folders.map((folder) => [folder, { path: folder, type: "entries" as const, names: ["package.json"] }])),
        notify,
      )
    })

    const select = Effect.fnUntraced(function* (entries: readonly Entry[]) {
      const groups = yield* Effect.forEach(Config.sourceGroups(entries), (group) =>
        group.plugins === undefined
          ? Effect.succeed([])
          : ConfigSourcePath.directories(
              fs,
              { source: group.document.path, kind: "plugins" },
              group.plugins,
              group.base ?? location.directory,
              global.home,
              group.project ? location.project.directory : undefined,
            ).pipe(Effect.map((listed) => [{ document: group.document, ...listed }])),
      ).pipe(Effect.map((groups) => groups.flat()))
      const directories = groups.flatMap((group) => group.directories)
      yield* watchListed(entries, directories)
      const read = yield* Effect.forEach(groups, (group) =>
        Effect.forEach(group.directories, (directory) =>
          PluginSourceDirectory.children(fs, directory).pipe(
            Effect.map((found) =>
              ConfigSourcePath.files({ source: group.document.path, kind: "plugins" }, directory, found),
            ),
          ),
        ).pipe(Effect.map((children) => ({ document: group.document, children }))),
      )
      yield* watchPackages(
        entries,
        read.flatMap((group) => group.children.flatMap((child) => child.files)),
      )
      reported.keys = yield* ConfigSourcePath.warn(
        reported.keys,
        ConfigSourcePath.keyed([
          ...groups.flatMap((group) => group.diagnostics),
          ...read.flatMap((group) => group.children.flatMap((child) => child.diagnostics)),
        ]),
      )
      return {
        selected: Config.effectiveSources(entries).load_only_selected === true,
        directories,
        listed: new Map(read.map((group) => [group.document, group.children.flatMap((child) => child.files)] as const)),
      } satisfies Selection
    })

    return Service.of({
      operations: Effect.fn("ConfigPluginSource.operations")(function* () {
        const entries = yield* config.entries()
        const enabled = flags.resolve(entries).config_sources.enabled
        if (!enabled) yield* Effect.all([watchListed(entries, []), watchPackages(entries, [])])
        const selection = enabled ? yield* select(entries) : undefined
        const operations = yield* scan(fs, location, entries, selection)
        yield* watchConfiguredSources(entries, selection?.directories ?? [], operations)
        return operations
      }),
      changes: () =>
        Stream.merge(
          config.changes().pipe(
            Stream.filterEffect((update) =>
              Effect.map(config.entries(), (entries) =>
                ConfigEntryObserver.isDirectorySource(entries, update.path, PluginSourceDirectory.names),
              ),
            ),
            Stream.map(() => undefined),
          ),
          Stream.fromPubSub(configuredChanges),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Flag.node, FSUtil.node, Watcher.node, Global.node, Location.node],
})

export const empty = makeLocationNode({
  service: Service,
  layer: Layer.succeed(
    Service,
    Service.of({
      operations: () => Effect.succeed([]),
      changes: () => Stream.never,
    }),
  ),
  deps: [],
})

function parse(input: ConfigPlugin.Plugin): Operation {
  if (typeof input !== "string") {
    return { type: "add", target: input.package, options: input.options ?? {} }
  }
  if (!input.startsWith("-")) return { type: "add", target: input, options: {} }
  if (input.length === 1) throw new Error("Plugin remove operation requires a target")
  return { type: "remove", target: input.slice(1) }
}

interface Selection {
  readonly selected: boolean
  readonly directories: readonly string[]
  readonly listed: ReadonlyMap<Entry, readonly string[]>
}

const scan = Effect.fn("ConfigPluginSource.scan")(function* (
  fs: FSUtil.Interface,
  location: Location.Interface,
  entries: readonly Entry[],
  selection: Selection | undefined,
) {
  const discovered = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      if (entry.type === "directory") {
        if (!selection?.selected || Config.isManaged(entry))
          return yield* PluginSourceDirectory.discover(fs, entry.path)
        yield* Effect.logDebug("default source root skipped", {
          kind: "plugins",
          root: entry.path,
          reason: "load_only_selected",
        })
        return []
      }
      return selection?.listed.get(entry) ?? []
    }),
  ).pipe(Effect.map((targets) => targets.flat().map((target): Operation => ({ type: "add", target, options: {} }))))
  const configured = entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) =>
      (entry.info.plugins ?? []).map(parse).map((operation) => {
        if (operation.type === "remove") return operation
        const directory = entry.path ? path.dirname(entry.path) : location.directory
        const target = operation.target.startsWith("file://")
          ? fileURLToPath(operation.target)
          : operation.target.startsWith("./") || operation.target.startsWith("../")
            ? path.resolve(directory, operation.target)
            : operation.target
        return { ...operation, target }
      }),
    )
  const resolved = yield* Effect.forEach(configured, (operation) =>
    Effect.gen(function* () {
      if (operation.type === "remove" || !path.isAbsolute(operation.target)) return Option.some(operation)
      if (yield* fs.isFile(operation.target)) {
        yield* Effect.logWarning("configured plugin path must be a directory", { target: operation.target })
        return Option.none<Operation>()
      }
      return Option.some<Operation>(operation)
    }),
  ).pipe(Effect.map((operations) => operations.flatMap(Option.toArray)))
  // Explicit config is applied last so it can remove auto-discovered packages.
  return yield* Effect.forEach([...discovered, ...resolved], (operation) =>
    Effect.gen(function* () {
      if (operation.type === "remove" || !path.isAbsolute(operation.target)) return [operation]
      if (!(yield* fs.existsSafe(operation.target))) return [operation]
      const directory = yield* fs.isDir(operation.target)
      const entrypoints: Host.Entrypoints = directory
        ? yield* Effect.sync(() => Host.resolve({ directory: operation.target }))
        : { server: pathToFileURL(operation.target).href }
      // A directory without a server part still lists for its GUI part. A TUI-only directory stays the TUI's own.
      const entrypoint = entrypoints.server ?? entrypoints.gui
      if (!entrypoint) return []
      if (directory) {
        const root = yield* fs.resolve(operation.target)
        const resolved = yield* fs.resolve(fileURLToPath(entrypoint))
        if (!FSUtil.contains(root, resolved)) return []
      }
      const times = yield* Effect.forEach(
        [
          ...Object.values(entrypoints)
            .filter((entry) => entry !== undefined)
            .map((entry) => fileURLToPath(entry)),
          path.join(directory ? operation.target : path.dirname(operation.target), "package.json"),
        ],
        (entry) =>
          fs.stat(entry).pipe(
            Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
            Effect.orElseSucceed(() => 0),
          ),
      )
      return [{ ...operation, mtime: Math.max(...times) }]
    }),
  ).pipe(Effect.map((operations) => operations.flat()))
})
