import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  discoverPublishablePackages,
  internalDependencies,
  type PublishablePackage,
  packageName,
  topologicalPublishOrder,
} from "../publishable-packages"

/**
 * The publish order is the one thing in the release path that cannot be checked after the fact:
 * publishing a package before something it depends on leaves a version on the registry whose
 * dependency does not resolve, and npm has no undo.
 */

const repoRoot = resolve(import.meta.dir, "..", "..")

function stub(name: string, dependencies: string[] = []): PublishablePackage {
  return {
    dir: `packages/${name.replace("@sixb/", "")}`,
    packageJson: {
      name,
      version: "0.1.0",
      dependencies: Object.fromEntries(dependencies.map((d) => [d, "workspace:*"])),
    },
  }
}

describe("topologicalPublishOrder", () => {
  test("puts every dependency before the package that needs it", () => {
    const ordered = topologicalPublishOrder([
      stub("@sixb/cli", ["@sixb/atlas", "create-sixb"]),
      stub("@sixb/atlas", ["@sixb/core", "@sixb/ui"]),
      stub("@sixb/core"),
      stub("@sixb/ui"),
      stub("create-sixb"),
    ]).map(packageName)

    expect(ordered.indexOf("@sixb/core")).toBeLessThan(ordered.indexOf("@sixb/atlas"))
    expect(ordered.indexOf("@sixb/ui")).toBeLessThan(ordered.indexOf("@sixb/atlas"))
    expect(ordered.indexOf("@sixb/atlas")).toBeLessThan(ordered.indexOf("@sixb/cli"))
    expect(ordered.indexOf("create-sixb")).toBeLessThan(ordered.indexOf("@sixb/cli"))
  })

  test("counts peer and optional dependencies as edges", () => {
    const ordered = topologicalPublishOrder([
      {
        dir: "packages/a",
        packageJson: {
          name: "@sixb/a",
          peerDependencies: { "@sixb/b": "workspace:*" },
          optionalDependencies: { "@sixb/c": "workspace:*" },
        },
      },
      stub("@sixb/b"),
      stub("@sixb/c"),
    ]).map(packageName)

    expect(ordered.indexOf("@sixb/b")).toBeLessThan(ordered.indexOf("@sixb/a"))
    expect(ordered.indexOf("@sixb/c")).toBeLessThan(ordered.indexOf("@sixb/a"))
  })

  test("ignores dependencies that are not publishable workspace packages", () => {
    const ordered = topologicalPublishOrder([
      {
        dir: "packages/a",
        packageJson: { name: "@sixb/a", dependencies: { react: "^19.0.0", zod: "^3.0.0" } },
      },
    ]).map(packageName)

    expect(ordered).toEqual(["@sixb/a"])
  })

  test("is deterministic across runs", () => {
    const input = [
      stub("@sixb/cli", ["@sixb/atlas"]),
      stub("@sixb/atlas", ["@sixb/core"]),
      stub("@sixb/core"),
      stub("@sixb/pg", ["@sixb/core"]),
      stub("@sixb/sqlite", ["@sixb/core"]),
    ]

    expect(topologicalPublishOrder(input).map(packageName)).toEqual(
      topologicalPublishOrder([...input].reverse()).map(packageName)
    )
  })

  test("refuses a cycle instead of dropping packages", () => {
    expect(() =>
      topologicalPublishOrder([stub("@sixb/a", ["@sixb/b"]), stub("@sixb/b", ["@sixb/a"])])
    ).toThrow(/Dependency cycle/)
  })
})

describe("the real workspace", () => {
  test("orders every publishable package after its dependencies", async () => {
    const packages = await discoverPublishablePackages(repoRoot)
    expect(packages.length).toBeGreaterThan(40)

    const ordered = topologicalPublishOrder(packages)
    expect(ordered.length).toBe(packages.length)

    const publishable = new Set(packages.map(packageName))
    const seen = new Set<string>()
    for (const packageInfo of ordered) {
      const unmet = [...internalDependencies(packageInfo.packageJson)]
        .filter((name) => publishable.has(name))
        .filter((name) => !seen.has(name))
      expect({ package: packageName(packageInfo), unmet }).toEqual({
        package: packageName(packageInfo),
        unmet: [],
      })
      seen.add(packageName(packageInfo))
    }
  })

  test("never lists a package twice", async () => {
    const ordered = topologicalPublishOrder(await discoverPublishablePackages(repoRoot))
    expect(new Set(ordered.map(packageName)).size).toBe(ordered.length)
  })
})
