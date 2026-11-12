import { expect } from "bun:test"
import { SystemPart } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Config } from "@opencode/core/config"
import { Flag } from "@opencode/core/flag"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { OutputStylePlugin } from "@opencode/core/plugin/output-style"
import { Project } from "@opencode/core/project"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Agent } from "@opencode/schema/agent"
import { Document, Info } from "@opencode/schema/config"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import type { ConfigOutputStyle } from "@opencode/schema/config/output-style"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import { host } from "./host"

const it = testEffect(Layer.merge(PluginTestLayer, Flag.testLayer()))

const sessionID = Session.ID.make("ses_output_style")

const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})

const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

const sessionInfo = (location: Location.Interface, parentID?: Session.ID) =>
  Session.Info.make({
    id: sessionID,
    ...(parentID === undefined ? {} : { parentID }),
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
  })

const document = (output_style: NonNullable<Info["output_style"]>) =>
  new Document({ type: "document", info: new Info({ output_style }) })

const flag = (output_style: boolean) =>
  new Document({ type: "document", info: new Info({ experimental: new ConfigExperimental.Info({ output_style }) }) })

const configure = (enabled: boolean, entries: Document[]) =>
  Effect.gen(function* () {
    const config = yield* Config.Test
    yield* config.setEntries([flag(enabled), ...entries])
  })

const activate = (parentID?: Session.ID) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const location = yield* Location.Service
    const session = sessionInfo(location, parentID)
    yield* OutputStylePlugin.Plugin.effect(
      host({
        location: new Location.Info({
          directory: location.directory,
          workspaceID: location.workspaceID,
          project: location.project,
        }),
        session: {
          hook: (name, callback, options) => hooks.register("session", name, callback, options),
          get: () => Effect.succeed(session),
        },
      }),
    )
  })

const prepare = (
  kind: "primary" | "compaction" | "generate" | "title",
  location: Location.Interface,
  parentID?: Session.ID,
) =>
  Effect.gen(function* () {
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    return yield* requests[kind]({
      session: sessionInfo(location, parentID),
      agent: Agent.ID.make("build"),
      model,
      system: [SystemPart.make("Base system")],
      messages: [],
    })
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport))

const texts = (request: { readonly system: ReadonlyArray<{ readonly text: string }> }) =>
  request.system.map((part) => part.text)

const style = (rules?: ConfigOutputStyle.Rule[]) => ({ text: "Be brief.", ...(rules ? { rules } : {}) })

const review = (text: string) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    return yield* hooks.trigger("session", "experimental.reply.before", {
      sessionID,
      agent: Agent.ID.make("build"),
      model: model.ref,
      text,
    })
  })

it.live("leaves the reply request unchanged while the flag is off or no style is set", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    yield* activate()
    for (const [enabled, entries] of [
      [false, [document(style())]],
      [true, []],
    ] as const) {
      yield* configure(enabled, [...entries])
      expect(texts((yield* prepare("primary", location)).event)).toEqual(["Base system"])
    }
  }),
)

it.live("appends the style to primary requests only, not to compaction, generate or title requests", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    yield* configure(true, [document(style())])
    yield* activate()

    expect(texts((yield* prepare("primary", location)).event)).toEqual(["Base system", "Be brief."])
    for (const kind of ["compaction", "generate", "title"] as const) {
      expect(texts((yield* prepare(kind, location)).event)).toEqual(["Base system"])
    }
  }),
)

it.live("applies the style to child sessions only when subagents is true", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    yield* activate(Session.ID.make("ses_parent"))
    for (const [subagents, expected] of [
      [false, ["Base system"]],
      [true, ["Base system", "Be brief."]],
    ] as const) {
      yield* configure(true, [document({ ...style(), subagents })])
      expect(texts((yield* prepare("primary", location)).event)).toEqual([...expected])
    }
  }),
)

it.live("rejects a reply that matches a must-not-match rule", () =>
  Effect.gen(function* () {
    yield* configure(true, [
      document(style([{ pattern: "\u2014", must: "not-match", message: "Do not use em dashes." }])),
    ])
    yield* activate()

    expect((yield* review("One \u2014 two")).reject).toContain("Do not use em dashes.")
  }),
)

it.live("rejects a reply that misses a must-match rule", () =>
  Effect.gen(function* () {
    yield* configure(true, [document(style([{ pattern: "^Running:", must: "match" }]))])
    yield* activate()

    expect((yield* review("Done.")).reject).toContain("/^Running:/m")
  }),
)

it.live("passes a reply that obeys every rule", () =>
  Effect.gen(function* () {
    yield* configure(true, [
      document(
        style([
          { pattern: "\u2014", must: "not-match" },
          { pattern: "^Running:", must: "match" },
        ]),
      ),
    ])
    yield* activate()

    expect((yield* review("Done.\nRunning: none")).reject).toBeUndefined()
  }),
)

it.live("registers no reply hook without rules", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* configure(true, [document(style())])
    yield* activate()

    expect(yield* hooks.has("session", "experimental.reply.before")).toBe(false)
  }),
)

it.live("does not hold subagent replies when subagents is false", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    yield* configure(true, [document(style([{ pattern: "^Running:", must: "match" }]))])
    yield* activate(Session.ID.make("ses_parent"))

    expect((yield* prepare("primary", location, Session.ID.make("ses_parent"))).reply).toBeUndefined()
  }),
)

it.live("never checks compaction, generate or title requests", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    yield* configure(true, [document(style([{ pattern: "^Running:", must: "match" }]))])
    yield* activate()

    expect((yield* prepare("primary", location)).reply).toBeDefined()
    for (const kind of ["compaction", "generate", "title"] as const) {
      expect((yield* prepare(kind, location)).reply).toBeUndefined()
    }
  }),
)
