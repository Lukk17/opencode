export * as PluginSourceDirectory from "./source-directory.js"

import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Option } from "effect"
import path from "path"

export const names = ["plugin", "plugins"] as const

export const discover = Effect.fn("PluginSourceDirectory.discover")(function* (
  fs: FSUtil.Interface,
  directory: string,
) {
  return (yield* Effect.forEach(names, (source) => children(fs, path.join(directory, source))))
    .flat()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
})

/** Lists the direct children of one plugin directory that load as plugins, sorted by path. */
export const children = Effect.fn("PluginSourceDirectory.children")(function* (
  fs: FSUtil.Interface,
  directory: string,
) {
  const entries = (yield* fs.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => [])))
    .map((entry) => ({ ...entry, target: path.join(directory, entry.name) }))
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
  const targets = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      const source = entry.target.endsWith(".ts") || entry.target.endsWith(".js")
      if (entry.type === "File" && source) return Option.some(entry.target)
      if (entry.type === "Directory") return Option.some(entry.target)
      if (entry.type !== "SymbolicLink") return Option.none<string>()
      if (source && (yield* fs.isFile(entry.target))) return Option.some(entry.target)
      if (yield* fs.isDir(entry.target)) return Option.some(entry.target)
      return Option.none<string>()
    }),
  )
  return targets.flatMap(Option.toArray)
})
