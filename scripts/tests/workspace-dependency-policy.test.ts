import { describe, expect, test } from "bun:test"
import type { PublishablePackage } from "../publishable-packages"
import { discoverPublishablePackages } from "../publishable-packages"
import {
  compatibleWorkspaceProtocol,
  coreInternalConsumerErrors,
  exactWorkspaceProtocol,
  expectedWorkspaceDependency,
  workspaceDependencyPolicyErrors,
} from "../workspace-dependency-policy"

function stub(
  dir: string,
  name: string,
  fields: Pick<PublishablePackage["packageJson"], "dependencies" | "peerDependencies"> = {}
): PublishablePackage {
  return { dir, packageJson: { name, version: "0.1.0", ...fields } }
}

describe("workspace dependency policy", () => {
  test("uses ranges for public APIs and peers for extension hosts", () => {
    const app = stub("packages/app", "@sixb/app")
    const connector = stub("connectors/example", "@sixb/connector-example")

    expect(expectedWorkspaceDependency(app, "@sixb/core")).toEqual({
      field: "dependencies",
      protocol: compatibleWorkspaceProtocol,
    })
    expect(expectedWorkspaceDependency(connector, "@sixb/core")).toEqual({
      field: "peerDependencies",
      protocol: compatibleWorkspaceProtocol,
    })
    expect(expectedWorkspaceDependency(connector, "@sixb/connector-rest")).toEqual({
      field: "dependencies",
      protocol: compatibleWorkspaceProtocol,
    })
  })

  test("keeps core-internal companions and the CLI runtime exact", () => {
    const server = stub("packages/server", "@sixb/server")
    const cli = stub("packages/cli", "@sixb/cli")

    expect(expectedWorkspaceDependency(server, "@sixb/core")).toEqual({
      field: "peerDependencies",
      protocol: exactWorkspaceProtocol,
    })
    expect(expectedWorkspaceDependency(cli, "@sixb/server")).toEqual({
      field: "dependencies",
      protocol: exactWorkspaceProtocol,
    })
    expect(expectedWorkspaceDependency(cli, "@sixb/app")).toEqual({
      field: "dependencies",
      protocol: compatibleWorkspaceProtocol,
    })
  })

  test("requires peer hosts to have an exact development dependency", () => {
    const connector = stub("connectors/example", "@sixb/connector-example", {
      peerDependencies: { "@sixb/core": compatibleWorkspaceProtocol },
    })

    expect(workspaceDependencyPolicyErrors(connector)).toEqual([
      "@sixb/connector-example must develop against @sixb/core as " +
        "devDependencies.@sixb/core workspace:* (found nothing).",
    ])
  })

  test("the publishable workspace follows the policy and exact cohort audit", async () => {
    const root = process.cwd()
    const packages = await discoverPublishablePackages(root)

    expect(packages.flatMap(workspaceDependencyPolicyErrors)).toEqual([])
    expect(await coreInternalConsumerErrors(root, packages)).toEqual([])
  })
})
