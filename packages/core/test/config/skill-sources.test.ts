import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode/core/bus"
import { ConfigCompatibilityPlugin } from "@opencode/core/config/plugin/compatibility"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Flag } from "@opencode/core/flag"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { Event } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { configLayer, globalDirectory } from "../fixture/config-layer"
import { location } from "../fixture/location"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(
  Layer.mergeAll(AppNodeBuilder.build(LayerNode.group([Skill.node, Bus.node, FSUtil.node])), Flag.testLayer()),
)

describe("Skill sources", () => {
  for (const [enabled, expected] of [
    [
      false,
      [
        "global-directory",
        "home-agents",
        "home-claude",
        "listed",
        "managed",
        "project-agents",
        "project-claude",
        "project-directory",
      ],
    ],
    [true, ["listed", "managed"]],
  ] as const)
    it.live(
      `loads ${enabled ? "only the listed and managed skills" : "every skill root"} with load_only_selected when the flag is ${enabled ? "on" : "off"}`,
      () =>
        withTempDir((tmp) =>
          Effect.gen(function* () {
            const home = path.join(tmp.path, "home")
            const project = path.join(tmp.path, "project")
            const system = path.join(tmp.path, "system")
            const roots = {
              "global-directory": path.join(globalDirectory(home), "skills"),
              "home-claude": path.join(home, ".claude", "skills"),
              "home-agents": path.join(home, ".agents", "skills"),
              "project-directory": path.join(project, ".opencode", "skills"),
              "project-claude": path.join(project, ".claude", "skills"),
              "project-agents": path.join(project, ".agents", "skills"),
              listed: path.join(project, "listed-skills"),
              managed: path.join(system, "skills"),
            }
            yield* Effect.promise(async () => {
              await Promise.all(
                Object.entries(roots).map(async ([name, directory]) => {
                  await fs.mkdir(path.join(directory, name), { recursive: true })
                  await fs.writeFile(
                    path.join(directory, name, "SKILL.md"),
                    `---\nname: ${name}\ndescription: Skill from ${name}\n---\n# ${name}`,
                  )
                }),
              )
              await fs.writeFile(
                path.join(project, "opencode.json"),
                JSON.stringify({
                  ...(enabled ? { experimental: { config_sources: true } } : {}),
                  skills: ["./listed-skills"],
                  sources: { load_only_selected: true },
                }),
              )
            })

            const skills = yield* Effect.gen(function* () {
              const service = yield* Skill.Service
              const bus = yield* Bus.Service
              const pluginHost = host({
                skill: {
                  list: () => Effect.die("unused skill.list"),
                  transform: service.transform,
                  reload: service.reload,
                },
                event: { subscribe: () => bus.subscribe(Event.Updated) },
              })
              yield* ConfigCompatibilityPlugin.Plugin.effect(pluginHost)
              yield* ConfigSkillPlugin.Plugin.effect(pluginHost).pipe(
                Effect.provideService(
                  SkillDiscovery.Service,
                  SkillDiscovery.Service.of({ pull: () => Effect.succeed([]) }),
                ),
                Effect.provideService(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(project) })),
                ),
              )
              return yield* service.list()
            }).pipe(Effect.provide(configLayer({ directory: project, home, options: { system } })))

            expect(skills.map((item): string => item.id).toSorted()).toEqual([...expected])
          }),
        ),
    )
})
