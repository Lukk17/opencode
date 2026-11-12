export * as ConfigSessionLinks from "./session-links.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.SessionLinks")({
  instruction: Schema.Boolean.pipe(optional).annotate({
    description:
      "Tell the model it may link sessions as [label](session:ses_...) and files by relative path while the experimental session_links flag is on (default: false)",
  }),
}) {}
