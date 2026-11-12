import { expect } from "bun:test"
import { SystemPart } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Flag } from "@opencode/core/flag"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginInternal } from "@opencode/core/plugin/internal"
import { SessionLinksPlugin } from "@opencode/core/plugin/session-links"
import { Project } from "@opencode/core/project"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Agent } from "@opencode/schema/agent"
import { Document, Info } from "@opencode/schema/config"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { emptyMcpLayer } from "../fixture/mcp"
import { offlineModels } from "../fixture/models"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import { host } from "./host"

const it = testEffect(Layer.merge(PluginTestLayer, Flag.testLayer()))

const internal = testEffect(
  AppNodeBuilder.build(PluginInternal.requirements, [
    Location.node.replace(tempLocationLayer),
    Mcp.node.replace(emptyMcpLayer),
    offlineModels,
  ]),
)

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

const configure = (flag: boolean, session_links: Info["session_links"]) =>
  Effect.gen(function* () {
    const config = yield* Config.Test
    yield* config.setEntries([
      new Document({
        type: "document",
        info: new Info({
          experimental: new ConfigExperimental.Info({ session_links: flag }),
          session_links,
        }),
      }),
    ])
  })

const activate = () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* SessionLinksPlugin.Plugin.effect(
      host({ session: { hook: (name, callback, options) => hooks.register("session", name, callback, options) } }),
    )
  })

const system = () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    const request = yield* requests.primary({
      session: Session.Info.make({
        id: Session.ID.make("ses_session_links"),
        projectID: Project.ID.global,
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
      }),
      agent: Agent.ID.make("build"),
      model,
      system: [SystemPart.make("Base system")],
      messages: [],
    })
    return request.event.system.map((part) => part.text)
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport))

it.live("adds the link instruction after the system prompt only while the flag and the setting are on", () =>
  Effect.gen(function* () {
    yield* activate()

    for (const [flag, instruction, added] of [
      [true, true, true],
      [false, true, false],
      [true, false, false],
    ]) {
      yield* configure(flag, { instruction })
      expect(yield* system()).toEqual(added ? ["Base system", SessionLinksPlugin.INSTRUCTION] : ["Base system"])
    }
  }),
)

internal.live("registers the session links plugin among the internal plugins that run first", () =>
  Effect.gen(function* () {
    const plugins = yield* PluginInternal.list()
    expect(plugins.pre.map((plugin) => plugin.id)).toContain(SessionLinksPlugin.Plugin.id)
  }),
)
