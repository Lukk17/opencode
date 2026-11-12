import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../src/config.js"

const decode = Schema.decodeUnknownSync(Config.Info)

describe("Config.OutputStyle", () => {
  test("accepts a style with text and rules, and rejects missing text, empty text or an unknown rule kind", () => {
    const input = {
      output_style: {
        text: "Be brief.",
        subagents: true,
        rules: [{ pattern: "^Running:", must: "match" as const, message: "End with a Running line." }],
      },
    }
    expect(Schema.encodeSync(Config.Info)(decode(input))).toEqual(input)
    for (const output_style of [
      {},
      { text: "" },
      { text: "Be brief.", rules: [{ pattern: "^Running:", must: "maybe" }] },
    ])
      expect(() => decode({ output_style })).toThrow()
  })
})
