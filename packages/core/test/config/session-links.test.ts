import { describe, expect, test } from "bun:test"
import { ConfigNormalize } from "@opencode/core/config/normalize"

function normalized(input: unknown) {
  const result = ConfigNormalize.normalize(input)
  expect(result.type).toBe("normalized")
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return result
}

describe("ConfigNormalize session_links", () => {
  test("keeps the instruction setting", () => {
    const result = normalized({ session_links: { instruction: true } })
    expect(result.encoded.session_links).toEqual({ instruction: true })
    expect(result.diagnostics).toEqual([])
  })
})
