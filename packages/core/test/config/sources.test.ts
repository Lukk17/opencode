import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Logger, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ConfigSourcePath } from "@opencode/core/config/source-path"
import { Credential } from "@opencode/core/credential"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Flag } from "@opencode/core/flag"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import { Directory, Document, type Entry, Event, Info } from "@opencode/schema/config"
import { ConfigSources } from "@opencode/schema/config/sources"
import { Integration } from "@opencode/schema/integration"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { configLayer, globalDirectory, sourceDiagnostics, write } from "../fixture/config-layer"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const flag = { experimental: { config_sources: true } }

describe("Config sources loading", () => {
  for (const enabled of [false, true])
    it.live(
      `${enabled ? "drops" : "keeps"} global config and home roots and keeps managed config when a project sets load_global false and the flag is ${enabled ? "on" : "off"}`,
      () =>
        withTempDir((tmp) =>
          Effect.gen(function* () {
            const { home, project } = yield* fixture(tmp.path, {
              ...(enabled ? flag : {}),
              sources: { load_global: false },
              shell: "project",
            })
            const system = path.join(tmp.path, "system")
            yield* write(path.join(system, "opencode.json"), { username: "managed" })
            const config = yield* Config.Service.use((config) =>
              Effect.all({ entries: config.entries(), compatibility: config.compatibility!() }),
            ).pipe(Effect.provide(configLayer({ directory: project, home, options: { system } })))
            const roots = (name: string) =>
              [...(enabled ? [] : [home]), project].map((root) => AbsolutePath.make(path.join(root, name)))

            expect(shells(config.entries)).toEqual(enabled ? ["project"] : ["global", "project"])
            expect(Config.latest(config.entries, "username")).toBe("managed")
            expect(directories(config.entries)).toEqual([
              ...(enabled ? [] : [AbsolutePath.make(globalDirectory(home))]),
              AbsolutePath.make(system),
            ])
            expect(config.compatibility).toEqual({ claude: roots(".claude"), agents: roots(".agents") })
          }),
        ),
    )

  for (const scope of ["global", "wellknown", "managed"] as const)
    it.live(`ignores load_global from ${scope} config and warns`, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const { home, project } = yield* fixture(tmp.path, { shell: "project" })
          const system = path.join(tmp.path, "system")
          const sources = { load_global: false }
          if (scope === "global")
            yield* write(path.join(globalDirectory(home), "opencode.json"), { sources, shell: "global" })
          if (scope === "managed") yield* write(path.join(system, "opencode.json"), { sources })
          const logs = sourceDiagnostics()
          const entries = yield* Config.Service.use((config) => config.entries()).pipe(
            Effect.provide(
              configLayer({
                directory: project,
                home,
                options: { system },
                overrides: "config_sources",
                ...(scope === "wellknown"
                  ? wellknown({ sources: { ...sources, agents: ["~/team-agents"], plugins: ["~/plugins"] } })
                  : {}),
              }),
            ),
            Effect.provide(Logger.layer([logs.logger])),
          )

          expect(shells(entries)).toEqual(["global", "project"])
          expect(Config.effectiveSources(entries).load_global).toBeUndefined()
          expect(Config.sourceGroups(entries)).toEqual([])
          expect(logs.output).toEqual([
            expect.objectContaining({
              scope,
              path: "$.sources.load_global",
              kind: "unsupported",
              action: `ignored load_global from ${scope} config because only project, explicit and content config can switch global config off`,
            }),
          ])
        }),
      ),
    )

  it.live("does not let a flag that only the global config turns on switch global config off", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* fixture(tmp.path, { sources: { load_global: false }, shell: "project" })
        yield* write(path.join(globalDirectory(home), "opencode.json"), { ...flag, shell: "global" })
        const entries = yield* Config.Service.use((config) => config.entries()).pipe(
          Effect.provide(configLayer({ directory: project, home })),
        )

        expect(shells(entries)).toEqual(["global", "project"])
      }),
    ),
  )

  it.live("applies load_global changes on reload", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* fixture(tmp.path, { ...flag, shell: "project" })
        const file = path.join(project, "opencode.json")
        yield* write(path.join(globalDirectory(home), "opencode.json"), {
          shell: "global",
          agents: { "global-only": { description: "Global agent", mode: "subagent" } },
        })
        yield* Effect.gen(function* () {
          const config = yield* Config.Service
          const globalAgent = (entries: readonly Entry[]) => Config.latest(entries, "agents")?.["global-only"]

          expect(globalAgent(yield* config.entries())).toBeDefined()
          const off = yield* save(file, { ...flag, sources: { load_global: false }, shell: "project" })
          expect(globalAgent(off)).toBeUndefined()
          expect(yield* config.compatibility!()).toEqual({
            claude: [AbsolutePath.make(path.join(project, ".claude"))],
            agents: [AbsolutePath.make(path.join(project, ".agents"))],
          })
          const on = yield* save(file, { ...flag, sources: { load_global: true }, shell: "project" })
          expect(globalAgent(on)).toBeDefined()
          expect(shells(on)).toEqual(["global", "project"])
        }).pipe(Effect.provide(configLayer({ directory: project, home })))
      }),
    ),
  )

  it.live("keeps global policies and permission rules in force when a project sets load_global false", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home, project } = yield* fixture(tmp.path, {
          ...flag,
          sources: { load_global: false },
          shell: "project",
          policies: [{ action: "provider.use", resource: "openai", effect: "allow" }],
          permissions: [{ action: "bash", resource: "*", effect: "allow" }],
        })
        yield* write(path.join(globalDirectory(home), "opencode.json"), {
          shell: "global",
          policies: [{ action: "provider.use", resource: "openai", effect: "deny" }],
          permissions: [{ action: "bash", resource: "rm *", effect: "deny" }],
        })
        const entries = yield* Config.Service.use((config) => config.entries()).pipe(
          Effect.provide(configLayer({ directory: project, home })),
        )

        expect(shells(entries)).toEqual(["project"])
        expect(directories(entries)).toEqual([])
        expect(ManagedPolicy.decision(ManagedPolicy.statements(entries), "provider.use", "openai")).toBe("deny")
        expect(entries.flatMap((entry) => (entry.type === "document" ? (entry.info.permissions ?? []) : []))).toEqual([
          { action: "bash", resource: "rm *", effect: "deny" },
          { action: "bash", resource: "*", effect: "allow" },
        ])
      }),
    ),
  )

  for (const placement of ["global", "managed"] as const)
    it.live(`lets ${placement} config_sources false forbid a project from turning sources on`, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const { home, project } = yield* fixture(tmp.path, {
            ...flag,
            sources: { load_global: false },
            shell: "project",
          })
          const system = path.join(tmp.path, "system")
          yield* write(path.join(placement === "global" ? globalDirectory(home) : system, "opencode.json"), {
            experimental: { config_sources: false },
            shell: placement,
          })
          const entries = yield* Config.Service.use((config) => config.entries()).pipe(
            Effect.provide(configLayer({ directory: project, home, options: { system } })),
          )
          const enabled = (items: readonly Entry[]) =>
            Flag.resolve({ entries: items, channel: "latest" }).config_sources.enabled

          expect(shells(entries)).toEqual(
            placement === "global" ? ["global", "project"] : ["global", "project", "managed"],
          )
          expect(enabled(entries)).toBe(false)
          expect(Config.loadsGlobal(entries, enabled)).toBe(true)
          expect(Flag.resolve({ entries, channel: "latest", overrides: "config_sources" }).config_sources).toEqual({
            enabled: true,
            source: "env",
          })
        }),
      ),
    )

  it.live("treats a project inside the global config directory as global config", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { home } = yield* fixture(tmp.path, { shell: "project" })
        const inner = path.join(globalDirectory(home), "inner")
        const file = path.join(inner, "opencode.json")
        yield* write(file, { ...flag, sources: { load_global: false }, shell: "inner" })
        const logs = sourceDiagnostics()
        const entries = yield* Config.Service.use((config) => config.entries()).pipe(
          Effect.provide(configLayer({ directory: inner, home })),
          Effect.provide(Logger.layer([logs.logger])),
        )

        expect(shells(entries)).toEqual(["global", "inner"])
        expect(Config.entryScope(entries.find((entry) => entry.type === "document" && entry.path === file)!)).toBe(
          "global",
        )
        expect(logs.output).toEqual([expect.objectContaining({ source: file, scope: "global" })])
      }),
    ),
  )
})

describe("Config sources helpers", () => {
  test("reads the latest values and keeps every listed directory in priority order", () => {
    const entries = [
      sourcesDocument("global", "/global/opencode.json", {
        agents: ["a"],
        load_only_selected: true,
        load_global: true,
      }),
      ...Config.scoped("global", [
        new Directory({ type: "directory", path: AbsolutePath.make(path.resolve("/global")) }),
      ]),
      sourcesDocument("direct", "/project/opencode.json", { agents: ["b"], plugins: ["p"], load_only_selected: false }),
      sourcesDocument("content", undefined, { load_global: false }),
    ]

    expect(Config.effectiveSources(entries)).toEqual(
      new ConfigSources.Info({ agents: ["a", "b"], plugins: ["p"], load_global: false, load_only_selected: false }),
    )
    expect(Config.effectiveSources([])).toEqual(new ConfigSources.Info({}))
  })

  test("resolves listed paths from home and from the listing document", () => {
    const home = path.resolve("/home/user")
    const base = path.resolve("/project")

    const accepted = (entry: string) => ConfigSourcePath.resolve(entry, base, home)

    expect(accepted("$HOME/agents")).toEqual({ type: "accepted", path: path.join(base, "$HOME", "agents") })
    expect(accepted("~/agents")).toEqual({ type: "accepted", path: path.join(home, "agents") })
    expect(accepted("./agents")).toEqual({ type: "accepted", path: path.join(base, "agents") })
    expect(accepted("../shared")).toEqual({ type: "accepted", path: path.resolve(base, "../shared") })
    expect(accepted("agents")).toEqual({ type: "accepted", path: path.join(base, "agents") })
    expect(accepted(path.resolve("/opt/agents"))).toEqual({ type: "accepted", path: path.resolve("/opt/agents") })
  })

  test("rejects the filesystem root, the home folder and its parents", () => {
    const home = path.resolve("/home/user")
    const base = path.resolve("/project")
    const reason = (entry: string) => {
      const resolved = ConfigSourcePath.resolve(entry, base, home)
      return resolved.type === "rejected" ? resolved.reason : undefined
    }

    expect(reason(path.parse(base).root)).toBe("root")
    expect(reason("../..")).toBe("root")
    expect(reason("~/")).toBe("home")
    expect(reason(home)).toBe("home")
    expect(reason(path.dirname(home))).toBe("home_parent")
    expect(reason("~/agents")).toBeUndefined()
  })

  test("keeps at most the limit of listed entries per document and reports each rejected one", () => {
    const home = path.resolve("/home/user")
    const base = path.resolve("/project")
    const entries = ["/", "~/", ...Array.from({ length: 1000 }, (_, index) => `./agents-${index}`)]
    const listed = ConfigSourcePath.list(entries, base, home)

    expect(listed.directories).toEqual(
      Array.from({ length: ConfigSourcePath.maxEntries - 2 }, (_, index) => path.join(base, `agents-${index}`)),
    )
    expect(listed.rejected).toEqual([
      { index: 0, entry: "/", reason: "root" },
      { index: 1, entry: "~/", reason: "home" },
    ])
    expect(listed.dropped).toBe(entries.length - ConfigSourcePath.maxEntries)
  })

  test("omits a malformed sources value with one diagnostic", () => {
    for (const sources of ["agents", { agents: "./agents" }, { agents: [""] }, { load_global: "no" }]) {
      const result = ConfigNormalize.normalize({ sources })
      if (result.type !== "normalized") throw new Error("expected normalized config")
      expect(result.encoded).not.toHaveProperty("sources")
      expect(result.diagnostics).toEqual([
        { kind: "invalid", path: ["sources"], message: "skipped malformed recognized value" },
      ])
    }
  })
})

const fixture = Effect.fnUntraced(function* (root: string, projectConfig: object) {
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  yield* Effect.promise(() =>
    Promise.all([
      fs.mkdir(path.join(home, ".claude"), { recursive: true }),
      fs.mkdir(path.join(home, ".agents"), { recursive: true }),
      fs.mkdir(path.join(project, ".claude"), { recursive: true }),
      fs.mkdir(path.join(project, ".agents"), { recursive: true }),
    ]),
  )
  yield* write(path.join(globalDirectory(home), "opencode.json"), { shell: "global" })
  yield* write(path.join(project, "opencode.json"), projectConfig)
  return { home, project }
})

function shells(entries: readonly Entry[]) {
  return entries.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : []))
}

function directories(entries: readonly Entry[]) {
  return entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
}

function sourcesDocument(
  scope: Config.Scope,
  filepath: string | undefined,
  sources: ConstructorParameters<typeof ConfigSources.Info>[0],
) {
  const document = new Document({
    type: "document",
    ...(filepath === undefined ? {} : { path: AbsolutePath.make(path.resolve(filepath)) }),
    info: new Info({ sources: new ConfigSources.Info(sources) }),
  })
  Config.scoped(scope, [document])
  return document
}

const save = Effect.fnUntraced(function* (file: string, input: object) {
  const config = yield* Config.Service
  const bus = yield* Bus.Service
  const watcher = yield* Watcher.Test
  const updated = yield* bus
    .subscribe(Event.Updated)
    .pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
  yield* write(file, input)
  yield* watcher.emit({ type: "update", path: file })
  yield* Fiber.join(updated).pipe(Effect.timeout("5 seconds"))
  return yield* config.entries()
})

function wellknown(config: WellKnown.Config) {
  const integrationID = Integration.ID.make("https://example.com")
  const entry: WellKnown.Entry = {
    origin: "https://example.com",
    integrationID,
    manifest: { auth: { command: ["login"], env: "TOKEN" } },
  }
  return {
    credentialNode: makeGlobalNode({
      service: Credential.Service,
      layer: Layer.mock(Credential.Service)({
        list: () =>
          Effect.succeed([
            new Credential.Info({
              id: Credential.ID.create(),
              integrationID,
              label: "default",
              value: Credential.Key.make({ type: "key", key: "secret" }),
            }),
          ]),
      }),
      deps: [],
    }),
    wellknownNode: makeGlobalNode({
      service: WellKnown.Service,
      layer: Layer.mock(WellKnown.Service)({
        entries: () => Effect.succeed([entry]),
        snapshot: () => [entry],
        resolve: () => Effect.succeed([config]),
      }),
      deps: [],
    }),
  }
}
