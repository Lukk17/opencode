import { Schema } from "effect"
import { Plugin, Store } from "@opencode/plugin/gui"
import en from "./i18n/en"

export default Plugin.define({
  stores: {
    auto: Store.session(Schema.Struct({ opened: Schema.Boolean }), { opened: false }),
  },
  i18n: { en },
})
