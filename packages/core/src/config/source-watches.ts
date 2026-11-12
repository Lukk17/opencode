export * as ConfigSourceWatches from "./source-watches.js"

import { Effect, FiberMap, Stream } from "effect"
import { Watcher } from "../filesystem/watcher.js"

/** Keeps exactly `targets` watched in `fibers` and runs `notify` on each change. */
export const sync = Effect.fnUntraced(function* (
  watcher: Watcher.Interface,
  fibers: FiberMap.FiberMap<string>,
  targets: ReadonlyMap<string, Watcher.WatchInput>,
  notify: Effect.Effect<void>,
) {
  for (const key of Array.from(fibers, ([key]) => key)) if (!targets.has(key)) yield* FiberMap.remove(fibers, key)
  for (const [key, watch] of targets) {
    if (yield* FiberMap.has(fibers, key)) continue
    yield* watcher.subscribe(watch).pipe(
      Effect.flatMap(Stream.runForEach(() => notify)),
      Effect.catchCause((cause) => Effect.logError("listed source watch failed", { target: watch.path, cause })),
      FiberMap.run(fibers, key, { startImmediately: true }),
    )
  }
})
