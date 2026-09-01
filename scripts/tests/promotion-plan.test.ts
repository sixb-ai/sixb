import { describe, expect, test } from "bun:test"
import { createPackagePromotionPlan } from "../promotion-plan"
import type { PublishablePackage } from "../publishable-packages"
import type { PackageRegistryState } from "../release-plan"
import { packageReleaseId } from "../release-plan"

function stub(name: string, version: string | undefined): PublishablePackage {
  return {
    dir: `packages/${name.replace("@sixb/", "")}`,
    packageJson: { name, version },
  }
}

function registry(versions: string[], tags: Record<string, string>): PackageRegistryState {
  return { versions: new Map(versions.map((version) => [version, {}])), tags }
}

describe("createPackagePromotionPlan", () => {
  test("promotes staged packages and skips packages already on the target", () => {
    const core = stub("@sixb/core", "0.1.4")
    const ui = stub("@sixb/ui", "0.1.1")
    const plan = createPackagePromotionPlan(
      [core, ui],
      new Map([
        ["@sixb/core", registry(["0.1.3", "0.1.4"], { next: "0.1.4", latest: "0.1.3" })],
        ["@sixb/ui", registry(["0.1.1"], { next: "0.1.1", latest: "0.1.1" })],
      ]),
      "next",
      "latest"
    )

    expect(plan.promote.map(packageReleaseId)).toEqual(["@sixb/core@0.1.4"])
    expect(plan.alreadyPromoted).toBe(1)
  })

  test("rejects the complete plan when a local version is not published", () => {
    const core = stub("@sixb/core", "0.1.4")

    expect(() =>
      createPackagePromotionPlan(
        [core],
        new Map([["@sixb/core", registry(["0.1.3"], { next: "0.1.3", latest: "0.1.3" })]]),
        "next",
        "latest"
      )
    ).toThrow(/Complete the staged publication first/)
  })

  test("rejects a published version that is not staged under the source tag", () => {
    const core = stub("@sixb/core", "0.1.4")

    expect(() =>
      createPackagePromotionPlan(
        [core],
        new Map([["@sixb/core", registry(["0.1.3", "0.1.4"], { next: "0.1.3", latest: "0.1.3" })]]),
        "next",
        "latest"
      )
    ).toThrow(/is not staged under "next"/)
  })

  test("rejects moving the target tag backwards", () => {
    const core = stub("@sixb/core", "0.1.4")

    expect(() =>
      createPackagePromotionPlan(
        [core],
        new Map([["@sixb/core", registry(["0.1.4", "0.2.0"], { next: "0.1.4", latest: "0.2.0" })]]),
        "next",
        "latest"
      )
    ).toThrow(/would move "latest" backwards/)
  })

  test("rejects preview promotion and identical source and target tags", () => {
    const core = stub("@sixb/core", "0.0.4")
    const states = new Map([
      ["@sixb/core", registry(["0.0.4"], { next: "0.0.4", latest: "0.0.3" })],
    ])

    expect(() => createPackagePromotionPlan([core], states, "next", "latest")).toThrow(
      /is a preview/
    )
    expect(() => createPackagePromotionPlan([core], states, "next", "next")).toThrow(
      /Source and target tags are both "next"/
    )
  })
})
