import { describe, expect, test } from "bun:test"
import type { PublishablePackage } from "../publishable-packages"
import {
  createPackageReleasePlan,
  type PackageRegistryState,
  type PublishedPackageManifest,
  packageReleaseId,
} from "../release-plan"

function stub(
  name: string,
  version: string | undefined,
  fields: {
    readonly dependencies?: Readonly<Record<string, string>>
    readonly peerDependencies?: Readonly<Record<string, string>>
  } = {}
): PublishablePackage {
  return {
    dir: `packages/${name.replace("@sixb/", "")}`,
    packageJson: {
      name,
      version,
      ...fields,
    },
  }
}

function registry(
  versions: Readonly<Record<string, PublishedPackageManifest>>,
  tags: Readonly<Record<string, string>> = {}
): PackageRegistryState {
  return { versions: new Map(Object.entries(versions)), tags }
}

describe("createPackageReleasePlan", () => {
  test("publishes only local versions missing from the registry", () => {
    const core = stub("@sixb/core", "0.1.2")
    const connector = stub("@sixb/connector-example", "0.1.2", {
      peerDependencies: { "@sixb/core": "workspace:^" },
    })
    const ui = stub("@sixb/ui", "0.1.0")

    const plan = createPackageReleasePlan(
      [core, connector, ui],
      new Map([
        ["@sixb/core", registry({ "0.1.0": {} })],
        ["@sixb/connector-example", registry({ "0.1.0": {} })],
        ["@sixb/ui", registry({ "0.1.0": {} }, { latest: "0.1.0", next: "0.1.0" })],
      ]),
      "next"
    )

    expect(plan.publish.map(packageReleaseId)).toEqual([
      "@sixb/core@0.1.2",
      "@sixb/connector-example@0.1.2",
    ])
    expect(plan.alreadyPublished).toBe(1)
  })

  test.each<{
    name: string
    versions: string[]
    tags: Record<string, string>
    tag: string
    error: RegExp
  }>([
    {
      // Regression proof: without assertReleaseAdvancesTags this returns a publish plan for 0.1.1.
      name: "rejects a release that would move latest backwards",
      versions: ["0.1.0", "0.2.0"],
      tags: { latest: "0.2.0" },
      tag: "latest",
      error: /would move the "latest" tag backwards from 0\.2\.0/,
    },
    {
      name: "rejects a staged release that would move next backwards",
      versions: ["0.1.0", "0.2.0"],
      tags: { latest: "0.1.0", next: "0.2.0" },
      tag: "next",
      error: /would move the "next" tag backwards from 0\.2\.0/,
    },
    {
      name: "rejects staging a stable release below the current latest version",
      versions: ["0.1.0", "0.2.0"],
      tags: { latest: "0.2.0", next: "0.1.0" },
      tag: "next",
      error: /would move the "latest" tag backwards from 0\.2\.0/,
    },
    {
      name: "rejects promoting an already-staged version below latest after a resumed run",
      versions: ["0.1.0", "0.1.1", "0.2.0"],
      tags: { latest: "0.2.0", next: "0.1.1" },
      tag: "next",
      error: /would move the "latest" tag backwards from 0\.2\.0/,
    },
  ])("$name", ({ versions, tags, tag, error }) => {
    const core = stub("@sixb/core", "0.1.1")
    const state = registry(Object.fromEntries(versions.map((version) => [version, {}])), tags)

    expect(() => createPackageReleasePlan([core], new Map([["@sixb/core", state]]), tag)).toThrow(
      error
    )
  })

  test("allows a release that advances both the staging and latest lines", () => {
    const core = stub("@sixb/core", "0.2.0")

    const plan = createPackageReleasePlan(
      [core],
      new Map([
        ["@sixb/core", registry({ "0.1.0": {}, "0.1.1": {} }, { latest: "0.1.1", next: "0.1.1" })],
      ]),
      "next"
    )

    expect(plan.publish.map(packageReleaseId)).toEqual(["@sixb/core@0.2.0"])
  })

  test("defers a package's first publication from a staged release", () => {
    // Regression proof: adding every missing version to publish puts this initial 0.1.0 on next.
    const connector = stub("@sixb/connector-example", "0.1.0")

    const plan = createPackageReleasePlan(
      [connector],
      new Map([["@sixb/connector-example", registry({})]]),
      "next"
    )

    expect(plan.publish).toEqual([])
    expect(plan.deferredInitial.map(packageReleaseId)).toEqual(["@sixb/connector-example@0.1.0"])
    expect(plan.alreadyPublished).toBe(0)
  })

  test("allows a package's explicit initial latest publication", () => {
    const connector = stub("@sixb/connector-example", "0.1.0")

    const plan = createPackageReleasePlan(
      [connector],
      new Map([["@sixb/connector-example", registry({})]]),
      "latest"
    )

    expect(plan.publish.map(packageReleaseId)).toEqual(["@sixb/connector-example@0.1.0"])
    expect(plan.deferredInitial).toEqual([])
  })

  test("rejects publishing a dependent while its initial dependency is deferred", () => {
    const core = stub("@sixb/core", "0.1.0")
    const connector = stub("@sixb/connector-example", "0.1.1", {
      dependencies: { "@sixb/core": "workspace:^" },
    })

    expect(() =>
      createPackageReleasePlan(
        [core, connector],
        new Map([
          ["@sixb/core", registry({})],
          ["@sixb/connector-example", registry({ "0.1.0": {} })],
        ]),
        "next"
      )
    ).toThrow(/@sixb\/connector-example@0\.1\.1 requires @sixb\/core@0\.1\.0/)
  })

  test("accepts an already-published internal dependency on its own version", () => {
    const rest = stub("@sixb/connector-rest", "0.1.0")
    const github = stub("@sixb/connector-github", "0.1.2", {
      dependencies: { "@sixb/connector-rest": "workspace:^" },
    })

    const plan = createPackageReleasePlan(
      [rest, github],
      new Map([
        ["@sixb/connector-rest", registry({ "0.1.0": {} })],
        ["@sixb/connector-github", registry({ "0.1.0": {} })],
      ]),
      "next"
    )

    expect(plan.publish.map(packageReleaseId)).toEqual(["@sixb/connector-github@0.1.2"])
  })

  test("rejects a plan that puts an unpublished dependency after its dependent", () => {
    const core = stub("@sixb/core", "0.1.2")
    const worker = stub("@sixb/worker", "0.1.2", {
      dependencies: { "@sixb/core": "workspace:*" },
    })
    const states = new Map([
      ["@sixb/core", registry({ "0.1.0": {} })],
      ["@sixb/worker", registry({ "0.1.0": {} })],
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
          registry({ "0.1.0": {}, "0.1.1": {} }, { latest: "0.1.0", next: "0.1.1" }),
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
      createPackageReleasePlan([core], new Map([["@sixb/core", registry({ "0.1.0": {} })]]), "next")
    ).toThrow(/@sixb\/core has no version/)
  })

  test("keeps a published caret edge when the current dependency remains compatible", () => {
    const core = stub("@sixb/core", "0.1.1")
    const connector = stub("@sixb/connector-example", "0.1.0", {
      peerDependencies: { "@sixb/core": "workspace:^" },
    })

    const plan = createPackageReleasePlan(
      [core, connector],
      new Map([
        ["@sixb/core", registry({ "0.1.0": {} })],
        [
          "@sixb/connector-example",
          registry({ "0.1.0": { peerDependencies: { "@sixb/core": "^0.1.0" } } }),
        ],
      ]),
      "next"
    )

    expect(plan.publish.map(packageReleaseId)).toEqual(["@sixb/core@0.1.1"])
  })

  test.each<{
    name: string
    coreVersion: string
    local: { peerDependencies?: Record<string, string> }
    published: PublishedPackageManifest
    error: RegExp
  }>([
    {
      name: "requires an exact consumer bump when its dependency version changes",
      coreVersion: "0.1.1",
      local: { peerDependencies: { "@sixb/core": "workspace:*" } },
      published: { peerDependencies: { "@sixb/core": "0.1.0" } },
      error: /Bump @sixb\/connector-example/,
    },
    {
      name: "requires a caret consumer bump at an incompatible version boundary",
      coreVersion: "0.2.0",
      local: { peerDependencies: { "@sixb/core": "workspace:^" } },
      published: { peerDependencies: { "@sixb/core": "^0.1.0" } },
      error: /Bump @sixb\/connector-example/,
    },
    {
      name: "requires a bump when a dependency moves to peerDependencies",
      coreVersion: "0.1.0",
      local: { peerDependencies: { "@sixb/core": "workspace:^" } },
      published: { dependencies: { "@sixb/core": "0.1.0" } },
      error: /workspace requires peerDependencies \^0\.1\.0/,
    },
    {
      name: "requires a bump when a published workspace dependency is removed",
      coreVersion: "0.1.0",
      local: {},
      published: { dependencies: { "@sixb/core": "0.1.0" } },
      error: /workspace requires nothing/,
    },
  ])("$name", ({ coreVersion, local, published, error }) => {
    const core = stub("@sixb/core", coreVersion)
    const connector = stub("@sixb/connector-example", "0.1.0", local)

    expect(() =>
      createPackageReleasePlan(
        [core, connector],
        new Map([
          ["@sixb/core", registry({ "0.1.0": {} })],
          ["@sixb/connector-example", registry({ "0.1.0": published })],
        ]),
        "next"
      )
    ).toThrow(error)
  })
})
