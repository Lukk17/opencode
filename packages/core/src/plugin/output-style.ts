export * as OutputStylePlugin from "./output-style.js"

import { SystemPart } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionReply, SessionRequest } from "@opencode/plugin/effect/session"
import type { ConfigOutputStyle } from "@opencode/schema/config/output-style"
import { Effect } from "effect"
import { Config } from "../config.js"
import { Flag } from "../flag.js"
import type { PluginInternal } from "./internal.js"

export const Plugin = define({
  id: "opencode.prompt.output-style",
  effect: Effect.fn("OutputStylePlugin")(function* (ctx) {
    const config = yield* Config.Service
    const flags = yield* Flag.Service

    const style = Effect.fnUntraced(function* (sessionID: SessionRequest["sessionID"]) {
      const entries = yield* config.entries()
      const settings = Config.latest(entries, "output_style")
      if (!flags.resolve(entries).output_style.enabled || !settings) return
      const session = yield* ctx.session.get({ sessionID }).pipe(Effect.orDie)
      return session.parentID === undefined || settings.subagents === true ? settings : undefined
    })

    const apply = Effect.fnUntraced(function* (event: SessionRequest) {
      const text = (yield* style(event.sessionID))?.text.trim()
      if (!text) return
      event.system.push(SystemPart.make(text))
    })

    const check = Effect.fnUntraced(function* (event: SessionReply) {
      const rules = (yield* style(event.sessionID))?.rules ?? []
      if (rules.length === 0) return
      const broken = yield* Effect.filter(rules, (rule) =>
        Effect.try(() => new RegExp(rule.pattern, "m").test(event.text) !== (rule.must === "match")).pipe(
          Effect.catch(() =>
            Effect.logWarning("skipped an output style rule whose pattern is not a valid regular expression", {
              pattern: rule.pattern,
            }).pipe(Effect.as(false)),
          ),
        ),
      )
      if (broken.length === 0) return
      event.reject = ["The reply broke these output style rules:", ...broken.map(describe)].join("\n")
    })

    yield* ctx.session.hook("context", apply)
    const entries = yield* config.entries()
    const settings = Config.latest(entries, "output_style")
    if (flags.resolve(entries).output_style.enabled && settings?.rules?.length)
      yield* ctx.session.hook("experimental.reply.before", check, { subagents: settings.subagents === true })
  }),
} satisfies PluginInternal.InternalPlugin)

const describe = (rule: ConfigOutputStyle.Rule) =>
  `- ${rule.message ?? `The reply must ${rule.must === "match" ? "match" : "not match"} /${rule.pattern}/m.`}`
