import { describe, expect, test } from "bun:test"
import type { PublishablePackage } from "../publishable-packages"
import {
  createPackageReleasePlan,
  type PackageRegistryState,
  packageReleaseId,
} from "../release-plan"

function stub(
  name: string,
  version: string | undefined,
  dependencies: readonly string[] = []
): PublishablePackage {
  return {
    dir: `packages/${name.replace("@sixb/", "")}`,
    packageJson: {
      name,
      version,
      dependencies: Object.fromEntries(
        dependencies.map((dependency) => [dependency, "workspace:*"])
      ),
    },
  }
}

function registry(
  versions: readonly string[],
  tags: Readonly<Record<string, string>> = {}
): PackageRegistryState {
  return { versions: new Set(versions), tags }
}

describe("createPackageReleasePlan", () => {
  test("publishes only local versions missing from the registry", () => {
    const core = stub("@sixb/core", "0.1.2")
    const connector = stub("@sixb/connector-example", "0.1.2", ["@sixb/core"])
    const ui = stub("@sixb/ui", "0.1.0")

    const plan = createPackageReleasePlan(
      [core, connector, ui],
      new Map([
        ["@sixb/core", registry(["0.1.0"])],
        ["@sixb/connector-example", registry(["0.1.0"])],
        ["@sixb/ui", registry(["0.1.0"], { latest: "0.1.0", next: "0.1.0" })],
      ]),
      "next"
    )

    expect(plan.publish.map(packageReleaseId)).toEqual([
      "@sixb/core@0.1.2",
      "@sixb/connector-example@0.1.2",
    ])
    expect(plan.alreadyPublished).toBe(1)
  })

  test("accepts an already-published internal dependency on its own version", () => {
    const rest = stub("@sixb/connector-rest", "0.1.0")
    const github = stub("@sixb/connector-github", "0.1.2", ["@sixb/connector-rest"])

    const plan = createPackageReleasePlan(
      [rest, github],
      new Map([
        ["@sixb/connector-rest", registry(["0.1.0"])],
        ["@sixb/connector-github", registry(["0.1.0"])],
      ]),
      "next"
    )

    expect(plan.publish.map(packageReleaseId)).toEqual(["@sixb/connector-github@0.1.2"])
  })

  test("rejects a plan that puts an unpublished dependency after its dependent", () => {
    const core = stub("@sixb/core", "0.1.2")
    const worker = stub("@sixb/worker", "0.1.2", ["@sixb/core"])
    const states = new Map([
      ["@sixb/core", registry(["0.1.0"])],
      ["@sixb/worker", registry(["0.1.0"])],
    ])

    expect(() => createPackageReleasePlan([worker, core], states, "next")).toThrow(
      /requires @sixb\/core@0\.1\.2 before it can publish/
    )
  })

  test("remembers an already-staged version for promotion after a resumed run", () => {
    const google = stub("@sixb/connector-google", "0.1.1")
    const plan = createPackageReleasePlan(
      [google],
      new Map([
        [
          "@sixb/connector-google",
          registry(["0.1.0", "0.1.1"], { latest: "0.1.0", next: "0.1.1" }),
        ],
      ]),
      "next"
    )

    expect(plan.publish).toEqual([])
    expect(plan.stagedForPromotion.map(packageReleaseId)).toEqual(["@sixb/connector-google@0.1.1"])
  })

  test("requires every package to declare a version", () => {
    const core = stub("@sixb/core", undefined)

    expect(() =>
      createPackageReleasePlan([core], new Map([["@sixb/core", registry(["0.1.0"])]]), "next")
    ).toThrow(/@sixb\/core has no version/)
  })
})
