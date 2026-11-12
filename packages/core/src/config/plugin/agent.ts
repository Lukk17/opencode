export * as ConfigAgentPlugin from "./agent.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import path from "path"
import { Effect, FiberMap, PubSub, Result, SchemaIssue, SchemaParser, Stream } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Flag } from "../../flag.js"
import { ConfigMarkdown } from "../markdown.js"
import { ConfigSourcePath } from "../source-path.js"
import { ConfigSourceWatches } from "../source-watches.js"
import { Watcher } from "../../filesystem/watcher.js"
import { ConfigEntryObserver } from "./entry-observer.js"
import { FSUtil } from "@opencode/util/fs-util"
import { ConfigAgentV1 } from "../../v1/config/agent.js"
import { ConfigMigrateV1 } from "../../v1/config/migrate.js"
import { Global } from "@opencode/util/global"
import { Permission } from "../../permission.js"
import type { FileAccess } from "../../file-access.js"
import type { ReadTool } from "../../tool/plugin/read.js"
import type { EditTool } from "../../tool/plugin/edit.js"
import { AbsolutePath } from "../../schema.js"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
// Keep in sync with the legacySources patterns and the name-strip regex in discover.
const sourceDirectories = ["agent", "agents", "mode", "modes"] as const
const decodeAgent = SchemaParser.decodeUnknownResult(ConfigAgent.Info)
const decodeLegacyAgent = SchemaParser.decodeUnknownResult(ConfigAgentV1.Info)
const formatIssue = SchemaIssue.makeFormatterDefault()
type PathAction = FileAccess.ExternalDirectoryAuthorization["action"] | typeof ReadTool.name | typeof EditTool.name
const pathActions = ["external_directory", "read", "edit"] as const satisfies readonly PathAction[]
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)])
// Fields only V2 understands. A file that uses any of them is read as V2, whatever else it contains.
const nativeKeys = ["permissions", "request", "system", "disabled"]

export const Plugin = define({
  id: "opencode.config.agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const flags = yield* Flag.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const watcher = yield* Watcher.Service
    const loadFiles = (files: readonly AgentFile[]) =>
      Effect.forEach(files, (file) =>
        fs.readFileStringSafe(file.filepath).pipe(
          Effect.flatMap((content) => (content ? decode(file, content) : Effect.succeed(undefined))),
          Effect.orElseSucceed(() => undefined),
        ),
      ).pipe(Effect.map((documents) => documents.filter((document): document is Document => document !== undefined)))
    const loadDirectory = (directory: string) => discover(fs, directory).pipe(Effect.flatMap(loadFiles))
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.type === "document") return [entry]
      if (entry.type !== "directory") return []
      return yield* loadDirectory(entry.path)
    })

    const sourceChanges = yield* PubSub.sliding<void>(1)
    const notifySources = PubSub.publish(sourceChanges, undefined).pipe(Effect.asVoid)
    const watched = yield* FiberMap.make<string>()
    const current: { selection?: Selection } = {}
    const missing = new Set<string>()
    const reported = { keys: new Set<string>() }
    const select = Effect.fnUntraced(function* (entries: readonly Entry[]) {
      if (!flags.resolve(entries).config_sources.enabled) return undefined
      const selected = Config.effectiveSources(entries).load_only_selected === true
      const available =
        config.compatibility === undefined ||
        !entries.some((entry) => entry.type === "document" && entry.info.sources !== undefined)
          ? []
          : (yield* config.compatibility()).agents
      const home = path.join(global.home, ".agents")
      const listed = yield* Effect.forEach(Config.sourceGroups(entries), (group) =>
        group.agents === undefined
          ? Effect.succeed([])
          : ConfigSourcePath.directories(
              fs,
              { source: group.document.path, kind: "agents" },
              group.agents,
              group.base ?? ctx.location.directory,
              global.home,
              group.project ? ctx.location.project.directory : undefined,
            ).pipe(Effect.map((result) => [{ document: group.document, ...result }])),
      ).pipe(Effect.map((groups) => groups.flat()))
      const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
      if (selected)
        yield* Effect.forEach(
          [
            ...entries.flatMap((entry) => (entry.type === "directory" && !Config.isManaged(entry) ? [entry.path] : [])),
            ...available,
          ],
          (root) =>
            Effect.logDebug("default source root skipped", { kind: "agents", root, reason: "load_only_selected" }),
        )
      return {
        selected,
        home: selected ? [] : available.filter((root) => root === home),
        project: selected ? [] : available.filter((root) => root !== home),
        groups: listed.map((group) => ({ document: group.document, directories: group.directories })),
        directories,
        diagnostics: listed.flatMap((group) => group.diagnostics),
      } satisfies Selection
    })
    const watchSources = Effect.fnUntraced(function* (selection: Selection | undefined) {
      const roots = selection === undefined ? [] : [...selection.home, ...selection.project]
      const listed = yield* Effect.forEach(
        [...new Set(selection?.groups.flatMap((group) => group.directories) ?? [])],
        (directory) => fs.isDir(directory).pipe(Effect.map((exists) => ({ directory, exists }))),
      )
      yield* Effect.forEach(listed, (item) => {
        if (item.exists || missing.has(item.directory)) return Effect.void
        missing.add(item.directory)
        return Effect.logWarning("listed source directory not found", { kind: "agents", directory: item.directory })
      })
      const outside = listed.filter(
        (item) => !selection?.directories.some((root) => FSUtil.contains(root, item.directory)),
      )
      const agentDirectories = yield* Effect.filter(
        roots.flatMap((root) => sourceDirectories.map((name) => path.join(root, name))),
        fs.isDir,
      )
      const targets = [
        ...outside.map(
          (item): Watcher.WatchInput =>
            item.exists
              ? directoryWatch(item.directory)
              : { path: path.dirname(item.directory), type: "entries", names: [path.basename(item.directory)] },
        ),
        ...agentDirectories.map(directoryWatch),
        ...roots.map((root): Watcher.WatchInput => ({ path: root, type: "entries", names: [...sourceDirectories] })),
      ]
      yield* ConfigSourceWatches.sync(
        watcher,
        watched,
        new Map(targets.map((watch) => [JSON.stringify(watch), watch] as const)),
        notifySources,
      )
    })
    const load = Effect.fn("ConfigAgentPlugin.load")(function* () {
      const entries = yield* config.entries()
      const selection = yield* select(entries)
      current.selection = selection
      yield* watchSources(selection)
      if (selection === undefined) return (yield* Effect.forEach(entries, loadEntry)).flat()
      const scans = new Map(
        yield* Effect.forEach(selection.groups, (group) =>
          Effect.forEach(group.directories, (directory) =>
            ConfigSourcePath.walk(fs, directory).pipe(
              Effect.map((found) => discoverListed({ source: group.document.path, kind: "agents" }, directory, found)),
            ),
          ).pipe(Effect.map((items) => [group.document, items] as const)),
        ),
      )
      const loadSelected = Effect.fnUntraced(function* (entry: Entry) {
        if (entry.type === "directory")
          return selection.selected && !Config.isManaged(entry) ? [] : yield* loadDirectory(entry.path)
        const items = scans.get(entry)
        if (items === undefined) return [entry]
        const documents = yield* Effect.forEach(items, (scan) => loadFiles(scan.files))
        return [...documents.flat(), entry]
      })
      const home =
        entries.findLastIndex((entry) => {
          const scope = Config.entryScope(entry)
          return scope === "policy" || scope === "integration" || scope === "wellknown" || scope === "global"
        }) + 1
      const project = entries.findIndex((entry, index) => {
        const scope = Config.entryScope(entry)
        return (
          index >= home &&
          (scope === "explicit" ||
            scope === "direct" ||
            scope === "project" ||
            scope === "content" ||
            scope === "managed")
        )
      })
      const end = project === -1 ? entries.length : project
      const sections = yield* Effect.all([
        Effect.forEach(entries.slice(0, home), loadSelected),
        Effect.forEach(selection.home, loadDirectory),
        Effect.forEach(entries.slice(home, end), loadSelected),
        Effect.forEach(selection.project, loadDirectory),
        Effect.forEach(entries.slice(end), loadSelected),
      ])
      reported.keys = yield* ConfigSourcePath.warn(
        reported.keys,
        ConfigSourcePath.keyed([
          ...selection.diagnostics,
          ...[...scans.values()].flat().flatMap((scan) => scan.diagnostics),
        ]),
      )
      return sections.flat(2)
    })
    yield* config.changes().pipe(
      Stream.filter((update) => {
        const selection = current.selection
        if (selection === undefined) return false
        return (
          path.basename(update.path) === ".agents" ||
          selection.groups.some((group) =>
            group.directories.some((directory) => FSUtil.contains(directory, update.path)),
          )
        )
      }),
      Stream.runForEach(() => notifySources),
      Effect.forkScoped({ startImmediately: true }),
    )
    const loaded = yield* ConfigEntryObserver.observeSources({
      config,
      event: ctx.event,
      directories: sourceDirectories,
      load,
      reload: ctx.agent.reload(),
      changes: Stream.fromPubSub(sourceChanges),
    })
    yield* ctx.agent.transform((editor) => {
      const permissions = expandPermissions(
        loaded.documents.flatMap((document) => document.info.permissions ?? []),
        global.home,
      )
      const configuredDefault = Config.latest(loaded.documents, "default_agent")
      if (configuredDefault !== undefined) editor.default(Agent.ID.make(configuredDefault))
      for (const current of editor.list()) {
        editor.update(current.id, (agent) => agent.permissions.push(...permissions))
      }

      for (const document of loaded.documents) {
        for (const [id, item] of Object.entries(document.info.agents ?? {})) {
          const agentID = Agent.ID.make(id)
          if (item.disabled) {
            editor.remove(agentID)
            continue
          }

          const exists = editor.get(agentID) !== undefined
          editor.update(agentID, (agent) => {
            if (!exists) agent.permissions.push(...permissions)
            if (item.model !== undefined)
              agent.model = {
                id: item.model.model,
                providerID: item.model.providerID,
                ...(item.model.variant === undefined ? {} : { variant: item.model.variant }),
              }
            if (item.request !== undefined) {
              Object.assign(agent.request.headers, item.request.headers ?? {})
              Object.assign(agent.request.body, item.request.body ?? {})
            }
            if (item.system !== undefined) agent.system = item.system
            if (item.description !== undefined) agent.description = item.description
            if (item.mode !== undefined) agent.mode = item.mode
            if (item.hidden !== undefined) agent.hidden = item.hidden
            if (item.color !== undefined) agent.color = item.color
            if (item.steps !== undefined) agent.steps = item.steps
            if (item.permissions !== undefined) {
              agent.permissions.push(...expandPermissions(item.permissions, global.home))
            }
          })
        }
      }
    })
  }),
})

interface Selection {
  readonly selected: boolean
  readonly home: readonly string[]
  readonly project: readonly string[]
  readonly groups: readonly { readonly document: Document; readonly directories: readonly string[] }[]
  readonly directories: readonly string[]
  readonly diagnostics: readonly Record<string, unknown>[]
}

interface AgentFile {
  readonly filepath: string
  readonly primary: boolean
  readonly name: string
}

function expandPermissions(rules: Permission.Ruleset, home: string): Permission.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

function isPathAction(action: string): action is PathAction {
  return pathActions.some((item) => item === action)
}

function expandHome(resource: string, home: string) {
  if (resource === "~" || resource === "$HOME") return home
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  return resource
}

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    fs
      .scan(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true, ignore: FSUtil.ignoreGlobs })
      .pipe(
        Effect.map((files) =>
          files.toSorted().map(
            (filepath): AgentFile => ({
              filepath,
              primary: source.primary,
              name: agentName(directory, filepath).replace(/^(agent|agents|mode|modes)\//, ""),
            }),
          ),
        ),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.orElseSucceed(() => []),
  )
}

function discoverListed(origin: ConfigSourcePath.Origin, directory: string, found: readonly string[]) {
  const result = ConfigSourcePath.files(origin, directory, found.toSorted())
  return {
    files: result.files
      .filter((filepath) => filepath.endsWith(".md"))
      .map((filepath): AgentFile => ({ filepath, primary: false, name: agentName(directory, filepath) })),
    diagnostics: result.diagnostics,
  }
}

function directoryWatch(directory: string): Watcher.WatchInput {
  return { path: directory, type: "directory", ignore: FSUtil.ignoreGlobs }
}

function agentName(directory: string, filepath: string) {
  return path.relative(directory, filepath).replaceAll("\\", "/").replace(/\.md$/, "")
}

const decode = Effect.fnUntraced(function* (file: AgentFile, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) {
    yield* Effect.logWarning("agent file skipped", { filepath: file.filepath, reason: "markdown" })
    return
  }
  const name = file.name
  const body = markdown.content.trim()
  const keys = Object.keys(markdown.data)
  const unsupported = keys.filter((key) => !agentKeys.has(key))
  const legacy = unsupported.length > 0 && !keys.some((key) => nativeKeys.includes(key))
  if (!legacy && unsupported.length > 0)
    yield* Effect.logWarning("ignored unsupported agent fields", { path: file.filepath, fields: unsupported })
  // Join legacy model + variant without sending native request/permissions through migration.
  // Embedded and structured native selections, and a variant without a model, stay unchanged.
  const data =
    typeof markdown.data.model === "string" &&
    !markdown.data.model.includes("#") &&
    typeof markdown.data.variant === "string" &&
    /^[^#]+$/.test(markdown.data.variant)
      ? { ...markdown.data, model: `${markdown.data.model}#${markdown.data.variant}` }
      : markdown.data
  const decoded = legacy
    ? Result.map(
        decodeLegacyAgent({ name, ...markdown.data, prompt: body }, { errors: "all" }),
        ConfigMigrateV1.migrateAgent,
      )
    : decodeAgent({ ...data, system: body }, { errors: "all" })
  if (Result.isFailure(decoded)) {
    yield* Effect.logWarning("agent file skipped", {
      filepath: file.filepath,
      reason: "frontmatter",
      issue: formatIssue(decoded.failure),
    })
    return
  }
  const agent = decoded.success
  const info = Info.make({
    agents: { [name]: file.primary ? ConfigAgent.Info.make({ ...agent, mode: "primary" }) : agent },
  })
  return new Document({ type: "document", path: AbsolutePath.make(file.filepath), info })
})
