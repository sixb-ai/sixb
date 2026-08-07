import { describe, expect, test } from "bun:test"
import { createSixbTemplateDependencyErrors } from "../create-sixb-template-policy"
import type { PublishablePackage } from "../publishable-packages"

function stub(name: string, version: string): PublishablePackage {
  return {
    dir: `packages/${name.replace("@sixb/", "")}`,
    packageJson: { name, version },
  }
}

describe("create-sixb template dependency policy", () => {
  test("accepts independent compatible ranges", () => {
    const errors = createSixbTemplateDependencyErrors(
      {
        dependencies: {
          "@sixb/core": "^0.2.0",
          "@sixb/ui": "^0.1.0",
          react: "^19.0.0",
        },
      },
      [stub("@sixb/core", "0.2.1"), stub("@sixb/ui", "0.1.4")]
    )

    expect(errors).toEqual([])
  })

  test("rejects only the stale package range", () => {
    // Regression proof: deriving every range from create-sixb cannot distinguish these two lines.
    const errors = createSixbTemplateDependencyErrors(
      {
        dependencies: {
          "@sixb/core": "^0.1.0",
          "@sixb/ui": "^0.1.0",
        },
      },
      [stub("@sixb/core", "0.2.0"), stub("@sixb/ui", "0.1.4")]
    )

    expect(errors).toEqual([
      "create-sixb requires @sixb/core ^0.1.0, which does not accept the workspace " +
        "version 0.2.0. Update only that template range.",
    ])
  })

  test("rejects workspace packages that are not publishable", () => {
    const errors = createSixbTemplateDependencyErrors(
      { dependencies: { "@sixb/missing": "^0.1.0" } },
      []
    )

    expect(errors).toEqual(["create-sixb declares unknown workspace package @sixb/missing."])
  })
})
