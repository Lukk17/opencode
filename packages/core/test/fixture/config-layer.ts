import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Flag } from "@opencode/core/flag"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "./config-nodes"
import { location } from "./location"
import { agentHost, host } from "../plugin/host"

/**
 * Real config loading for a project directory, with the global config directory at `<home>/.config/opencode`, no
 * system directory, the test watcher, and `OPENCODE_FLAGS` taken from `overrides` instead of the environment.
 */
export function configLayer(input: {
  readonly directory: string
  readonly home: string
  readonly options?: Config.Options
  readonly overrides?: string
  readonly credentialNode?: typeof emptyCredentialNode
  readonly wellknownNode?: typeof emptyWellknownNode
}) {
  const watcher = Watcher.testLayer
  const built = AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, FSUtil.node, Global.node, Watcher.node]), [
    Config.node.replace(Config.configured({ system: false, ...input.options })),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(input.directory) }))),
    ),
    Global.node.replace(Global.layerWith({ config: globalDirectory(input.home), home: input.home })),
    Credential.node.replace(input.credentialNode ?? emptyCredentialNode),
    WellKnown.node.replace(input.wellknownNode ?? emptyWellknownNode),
    Watcher.node.replace(watcher),
  ])
  return Layer.mergeAll(built, watcher).pipe(Layer.provide(Layer.succeed(Flag.Overrides, input.overrides)))
}

export function globalDirectory(home: string) {
  return path.join(home, ".config", "opencode")
}

/** A plugin host whose location is `directory`, so relative paths in documents without a path resolve there. */
export function projectHost(agents: Agent.Interface, directory: string) {
  const project = AbsolutePath.make(directory)
  return host({
    agent: agentHost(agents),
    location: new Location.Info({
      directory: project,
      project: { id: Project.ID.global, directory: project, canonical: project },
    }),
  })
}

export function write(file: string, content: string | object = "") {
  return Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
  })
}

export function sourceDiagnostics() {
  const output: unknown[] = []
  const logger = Logger.map(Logger.formatStructured, (entry) => {
    if (Array.isArray(entry.message) && entry.message[0] === "configuration sources diagnostic")
      output.push(entry.message[1])
  })
  return { output, logger }
}
