export * as ConfigCompatibilityPlugin from "./compatibility.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import path from "path"
import { isDeepStrictEqual } from "node:util"
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { Flag } from "../../flag.js"
import { Skill } from "../../skill.js"
import { SkillFile } from "./skill-file.js"
import { SkillScan } from "./skill-scan.js"

export const Plugin = define({
  id: "opencode.config.compatibility",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const flags = yield* Flag.Service
    const fs = yield* FSUtil.Service
    const watcher = yield* Watcher.Service
    const watches = yield* FiberMap.make<string>()
    const changes = yield* PubSub.sliding<string>(1)
    const lock = Semaphore.makeUnsafe(1)
    const skills: Skill.Info[] = []
    const compatibility = () =>
      config.compatibility ? config.compatibility() : Effect.succeed({ claude: [], agents: [] })
    const selected = (entries: readonly Entry[]) =>
      flags.resolve(entries).config_sources.enabled && Config.effectiveSources(entries).load_only_selected === true
    const scanned = { enabled: false, selected: false, roots: yield* compatibility() }

    const watch = Effect.fn("ConfigCompatibilityPlugin.watch")(function* (
      target: string,
      type: "file" | "directory",
    ) {
      const updates = yield* watcher.subscribe(
        type === "directory" ? { path: target, type, ignore: SkillScan.ignore } : { path: target, type },
      )
      yield* FiberMap.run(
        watches,
        `${type}:${target}`,
        updates.pipe(Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid))),
        { onlyIfMissing: true, startImmediately: true },
      )
    })

    const refresh = Effect.fn("ConfigCompatibilityPlugin.refresh")(
      function* () {
        yield* FiberMap.clear(watches)
        const roots = yield* compatibility()
        const entries = yield* config.entries()
        scanned.enabled = flags.resolve(entries).config_sources.enabled
        scanned.selected = selected(entries)
        scanned.roots = roots
        if (scanned.selected)
          yield* Effect.forEach([...roots.claude, ...roots.agents], (root) =>
            Effect.logDebug("default source root skipped", { kind: "skills", root, reason: "load_only_selected" }),
          )
        const directories = scanned.selected
          ? []
          : [...roots.claude, ...roots.agents].map((root) => path.join(root, "skills"))
        const loaded = new Map<Skill.ID, Skill.Info>()
        for (const directory of directories) {
          const resolved = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
          if (!resolved) continue
          yield* watch(resolved, "directory")
          for (const filepath of yield* SkillScan.scan(resolved)) {
            const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
            if (!content) continue
            const parsed = SkillFile.parse(resolved, filepath, content)
            if (parsed._tag === "Parsed") loaded.set(parsed.skill.id, parsed.skill)
          }
        }
        skills.splice(0, skills.length, ...loaded.values())
      },
      (effect) => lock.withPermit(effect),
    )

    const reload = refresh().pipe(Effect.andThen(ctx.skill.reload()))
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* config.changes().pipe(
      Stream.filterEffect((update) =>
        Effect.map(compatibility(), (roots) => isCompatibilitySource(roots, update.path)),
      ),
      Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* ctx.event.subscribe({ types: ["config.updated"] }).pipe(
      Stream.filterEffect(() =>
        Effect.all([config.entries(), compatibility()]).pipe(
          Effect.map(
            ([entries, roots]) =>
              (scanned.enabled || flags.resolve(entries).config_sources.enabled) &&
              (selected(entries) !== scanned.selected || !isDeepStrictEqual(roots, scanned.roots)),
          ),
        ),
      ),
      Stream.runForEach(() => PubSub.publish(changes, "config.updated").pipe(Effect.asVoid)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh()
    yield* ctx.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill)
    })
  }),
})

const sourceDirectories = [".claude", ".agents"] as const

function isCompatibilitySource(
  roots: { readonly claude: readonly string[]; readonly agents: readonly string[] },
  file: string,
) {
  return (
    sourceDirectories.some((name) => path.basename(file) === name) ||
    [...roots.claude, ...roots.agents].some((root) => FSUtil.contains(root, file))
  )
}
