export * as SessionLinksPlugin from "./session-links.js"

import { SystemPart } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../config.js"
import { Flag } from "../flag.js"

export const INSTRUCTION =
  "You may link to a subagent session you started or know with [label](session:ses_ID). You may link to files with a relative path such as [label](src/file.ts#L10). Do not invent session IDs."

export const Plugin = define({
  id: "opencode.prompt.session-links",
  effect: Effect.fn("SessionLinksPlugin")(function* (ctx) {
    const config = yield* Config.Service
    const flags = yield* Flag.Service
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const entries = yield* config.entries()
        if (!flags.resolve(entries).session_links.enabled) return
        if (Config.latest(entries, "session_links")?.instruction !== true) return
        event.system.push(SystemPart.make(INSTRUCTION))
      }),
    )
  }),
})
