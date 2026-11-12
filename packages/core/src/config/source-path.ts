export * as ConfigSourcePath from "./source-path.js"

import { FSUtil } from "@opencode/util/fs-util"
import { Effect } from "effect"
import path from "path"

/** The most entries one config document may list under `sources.agents` or `sources.plugins`. */
export const maxEntries = 32
/**
 * The most files and folders OpenCode reads in one listed directory. A walk stops once it finds more.
 */
export const maxFiles = 1000

/**
 * Why a listed path is not used: the filesystem root, the home folder, a parent of it, or a path outside the project
 * that project config lists.
 */
export type Rejection = "root" | "home" | "home_parent" | "outside_project"

export type Resolved =
  | { readonly type: "accepted"; readonly path: string }
  | { readonly type: "rejected"; readonly reason: Rejection }

export interface Listed {
  readonly directories: readonly string[]
  readonly rejected: readonly { readonly index: number; readonly entry: string; readonly reason: Rejection }[]
  readonly dropped: number
}

export const reasons = {
  root: "is the filesystem root",
  home: "is the home folder",
  home_parent: "is a parent of the home folder",
  outside_project: "is outside the project",
} satisfies Record<Rejection, string>

/**
 * Resolves the entries one document lists, keeping at most `maxEntries`. A rejected entry is reported once and never
 * scanned or watched.
 */
export function list(entries: readonly string[], base: string, home: string): Listed {
  const resolved = entries.slice(0, maxEntries).map((entry, index) => ({ index, entry, ...resolve(entry, base, home) }))
  return {
    directories: resolved.flatMap((item) => (item.type === "accepted" ? [item.path] : [])),
    rejected: resolved.flatMap((item) =>
      item.type === "rejected" ? [{ index: item.index, entry: item.entry, reason: item.reason }] : [],
    ),
    dropped: Math.max(0, entries.length - maxEntries),
  }
}

/**
 * Resolves a listed source path: `~/` against the home directory, a relative path against `base`, the directory of
 * the listing document.
 */
export function resolve(entry: string, base: string, home: string): Resolved {
  const resolved = entry.startsWith("~/") ? path.join(home, entry.slice(2)) : path.resolve(base, entry)
  const reason = rejection(resolved, home)
  return reason === undefined ? { type: "accepted", path: resolved } : { type: "rejected", reason }
}

/** Returns why `directory` may not be listed, or `undefined` when it may. */
export function rejection(directory: string, home: string): Rejection | undefined {
  if (path.dirname(directory) === directory) return "root"
  if (!FSUtil.contains(directory, home)) return undefined
  return FSUtil.contains(home, directory) ? "home" : "home_parent"
}

/** Where a listed entry comes from: the config document that lists it and the `sources` key it is listed under. */
export interface Origin {
  readonly source: string | undefined
  readonly kind: "agents" | "plugins"
}

/**
 * Resolves the directories one document lists. With `project`, the list comes from project config and a directory
 * outside that folder is rejected.
 */
export const directories = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  origin: Origin,
  entries: readonly string[],
  base: string,
  home: string,
  project: string | undefined,
) {
  const listed = list(entries, base, home).directories
  const roots = project === undefined ? undefined : [project, yield* fs.resolve(project)]
  const outside = (directory: string) => roots !== undefined && !roots.some((root) => FSUtil.contains(root, directory))
  return {
    directories: listed.filter((directory) => !outside(directory)),
    diagnostics: listed
      .filter(outside)
      .map((directory) => diagnostic(origin, "rejected", `ignored ${directory} because it ${reasons.outside_project}`)),
  }
})

/** Lists the files and folders below a listed directory. The walk stops after `maxFiles + 1` of them. */
export function walk(fs: FSUtil.Interface, directory: string) {
  return fs
    .scan("**/*", {
      cwd: directory,
      absolute: true,
      include: "all",
      dot: true,
      ignore: FSUtil.ignoreGlobs,
      limit: maxFiles + 1,
    })
    .pipe(Effect.orElseSucceed(() => []))
}

/** Keeps the first `maxFiles` of `found`, and reports a directory that holds more. */
export function files(origin: Origin, directory: string, found: readonly string[]) {
  return {
    files: found.slice(0, maxFiles),
    diagnostics:
      found.length > maxFiles
        ? [
            diagnostic(
              origin,
              "truncated",
              `read only the first ${maxFiles} files and folders in ${directory}, list a smaller folder`,
            ),
          ]
        : [],
  }
}

function diagnostic(origin: Origin, kind: "rejected" | "truncated", action: string) {
  return { source: origin.source, path: `$.sources.${origin.kind}`, kind, action }
}

/** Logs each diagnostic whose key the previous load did not report, and returns the keys reported now. */
export const warn = Effect.fnUntraced(function* (
  previous: ReadonlySet<string>,
  diagnostics: ReadonlyMap<string, Record<string, unknown>>,
) {
  yield* Effect.forEach(diagnostics, ([key, details]) =>
    previous.has(key) ? Effect.void : Effect.logWarning("configuration sources diagnostic", details),
  )
  return new Set(diagnostics.keys())
})

/** Keys diagnostics by their content. */
export function keyed(diagnostics: readonly Record<string, unknown>[]) {
  return new Map(diagnostics.map((details) => [JSON.stringify(details), details] as const))
}
