import { glob, globIterate, type GlobOptionsWithFileTypesFalse } from "glob"
import { minimatch } from "minimatch"

export namespace Glob {
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
    ignore?: string[]
    /** Stops the walk once this many matches are found, in the order the walk finds them. */
    limit?: number
  }

  function toGlobOptions(options: Options): GlobOptionsWithFileTypesFalse {
    return {
      cwd: options.cwd,
      absolute: options.absolute,
      dot: options.dot,
      follow: options.symlink ?? false,
      nodir: options.include !== "all",
      ignore: options.ignore,
    }
  }

  export async function scan(pattern: string, options: Options = {}): Promise<string[]> {
    if (options.limit === undefined) return glob(pattern, toGlobOptions(options))
    const matches: string[] = []
    for await (const match of globIterate(pattern, toGlobOptions(options))) {
      if (matches.length >= options.limit) break
      matches.push(match)
    }
    return matches
  }

  export function match(pattern: string, filepath: string): boolean {
    return minimatch(filepath, pattern, { dot: true })
  }
}
