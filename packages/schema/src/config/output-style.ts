export * as ConfigOutputStyle from "./output-style.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export const Rule = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "Regular expression checked against the reply, where ^ and $ match at each line",
  }),
  must: Schema.Literals(["match", "not-match"]).annotate({
    description: "Whether the reply must match the pattern or must not match it",
  }),
  message: Schema.String.pipe(optional).annotate({ description: "Note for the model when the reply breaks the rule" }),
}).annotate({ identifier: "Config.OutputStyleRule" })
export type Rule = typeof Rule.Type

export const Info = Schema.Struct({
  subagents: Schema.Boolean.pipe(optional).annotate({
    description: "Also add the style to subagent requests (default: false)",
  }),
  text: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "Style text" }),
  rules: Schema.Array(Rule).pipe(optional).annotate({
    description: "Rules each reply must follow. A reply that breaks one goes back to the model, at most twice",
  }),
}).annotate({ identifier: "Config.OutputStyle" })
export type Info = typeof Info.Type
