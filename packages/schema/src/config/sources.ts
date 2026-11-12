export * as ConfigSources from "./sources.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

const SourcePath = Schema.String.pipe(Schema.check(Schema.isNonEmpty()))

export class Info extends Schema.Class<Info>("Config.Sources")({
  agents: SourcePath.pipe(Schema.Array, optional).annotate({
    description: "Additional directories scanned for agent markdown files",
  }),
  plugins: SourcePath.pipe(Schema.Array, optional).annotate({
    description: "Directories whose direct children load as plugins",
  }),
  load_global: Schema.Boolean.pipe(optional).annotate({
    description: "Load the global configuration directory and home compatibility roots (default: true)",
  }),
  load_only_selected: Schema.Boolean.pipe(optional).annotate({
    description: "Load agents, skills and plugins only from explicitly listed paths (default: false)",
  }),
}) {}
