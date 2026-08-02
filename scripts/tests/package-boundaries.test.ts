import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  artifactScope,
  findAliasDrift,
  findUndeclaredImports,
  type ManifestDependencies,
  siblingSpecifierPattern,
  sourceScope,
  workspaceBoundaryPlugins,
} from "../package-boundaries"
import type { ExportTarget, PublishablePackage } from "../publishable-packages"

/**
 * These cover the rule itself. `build-package.test.ts` covers the wiring — that the bundler is
 * actually handed the patterns computed here.
 */

const fixtureRoots: string[] = []

afterEach(async () => {
  while (fixtureRoots.length > 0) {
    const fixtureRoot = fixtureRoots.pop()
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  }
})

describe("siblingSpecifierPattern", () => {
  test("matches a sibling whole and at every subpath", () => {
    const pattern = patternFor({ dependencies: { "@sixb/ui": "workspace:*" } })

    expect(pattern.test("@sixb/ui")).toBe(true)
    expect(pattern.test("@sixb/ui/button")).toBe(true)
    expect(pattern.test("@sixb/ui/components/ui/chart")).toBe(true)
  })

  test("never matches a package whose name merely starts the same", () => {
    // The reason this is a regexp and not an `external: ["@sixb/cli*"]` pattern: that glob also
    // catches `@sixb/client`, and externalizing a package this one does not depend on emits an
    // import nothing installs.
    const pattern = patternFor({ dependencies: { "@sixb/cli": "workspace:*" } })

    expect(pattern.test("@sixb/cli")).toBe(true)
    expect(pattern.test("@sixb/client")).toBe(false)
    expect(pattern.test("@sixb/client/browser")).toBe(false)
  })

  test("covers every dependency field and leaves third-party packages alone", () => {
    const pattern = patternFor({
      dependencies: { "@sixb/core": "workspace:*", tailwindcss: "^4.1.18" },
      peerDependencies: { "@sixb/client": "workspace:*", react: "^19.0.0" },
      optionalDependencies: { "create-sixb": "workspace:*" },
    })

    expect(pattern.test("@sixb/core/agents/context")).toBe(true)
    expect(pattern.test("@sixb/client/browser")).toBe(true)
    expect(pattern.test("create-sixb/scaffold")).toBe(true)
    expect(pattern.test("tailwindcss")).toBe(false)
    expect(pattern.test("react")).toBe(false)
  })

  test("is null when a package has no siblings, so nothing is intercepted", () => {
    expect(siblingSpecifierPattern({ dependencies: { react: "^19.0.0" } })).toBeNull()
    expect(siblingSpecifierPattern({})).toBeNull()
  })
})

describe("workspaceBoundaryPlugins", () => {
  test("installs one resolver, and none at all without siblings", () => {
    expect(workspaceBoundaryPlugins({ dependencies: { "@sixb/ui": "workspace:*" } })).toHaveLength(
      1
    )
    expect(workspaceBoundaryPlugins({ dependencies: { react: "^19.0.0" } })).toEqual([])
  })
})

describe("findUndeclaredImports", () => {
  test("reports a bare import the manifest never declared", async () => {
    const { packageRoot, manifest } = await packageWith(
      { name: "@sixb/example", dependencies: { "@sixb/core": "workspace:*" } },
      {
        "src/index.ts": 'import { thing } from "@sixb/core"\nimport { other } from "recharts"\n',
      }
    )

    expect(await findUndeclaredImports(packageRoot, manifest, sourceScope)).toEqual([
      { specifier: "recharts", file: "index.ts" },
    ])
  })

  test("accepts declared packages, their subpaths, relative paths, builtins, and self-reference", async () => {
    const { packageRoot, manifest } = await packageWith(
      {
        name: "@sixb/example",
        dependencies: { "@sixb/core": "workspace:*" },
        peerDependencies: { react: "^19.0.0" },
      },
      {
        "src/index.ts": [
          'import { readFile } from "node:fs/promises"',
          'import { Glob } from "bun"',
          'import { createElement } from "react"',
          'import { context } from "@sixb/core/agents/context"',
          'import { helper } from "@sixb/example/helper"',
          'import { local } from "./local"',
          "",
        ].join("\n"),
        "src/local.ts": "export const local = 1\n",
      }
    )

    expect(await findUndeclaredImports(packageRoot, manifest, sourceScope)).toEqual([])
  })

  test("ignores type-only imports, which resolve against devDependencies legitimately", async () => {
    const { packageRoot, manifest } = await packageWith(
      { name: "@sixb/example" },
      {
        "src/index.ts": [
          'import type { Database } from "@sixb/sqlite"',
          'export type { Row } from "@sixb/sqlite"',
          "export type Alias = Database",
          "",
        ].join("\n"),
      }
    )

    expect(await findUndeclaredImports(packageRoot, manifest, sourceScope)).toEqual([])
  })

  test("does not read import statements out of a template literal", async () => {
    // `@sixb/app` generates a custom-app entry as source text. A regex reads those lines as this
    // package's own imports; a parser does not.
    const { packageRoot, manifest } = await packageWith(
      { name: "@sixb/example" },
      {
        "src/index.ts": [
          "export const generated = `",
          'import { signOut } from "@sixb/client"',
          "`",
          "",
        ].join("\n"),
      }
    )

    expect(await findUndeclaredImports(packageRoot, manifest, sourceScope)).toEqual([])
  })

  test("parses an artifact behind a shebang", async () => {
    const { packageRoot, manifest } = await packageWith(
      { name: "@sixb/example" },
      { "dist/cli.js": '#!/usr/bin/env bun\nimport { render } from "ink"\n' }
    )

    expect(await findUndeclaredImports(packageRoot, manifest, artifactScope)).toEqual([
      { specifier: "ink", file: "cli.js" },
    ])
  })

  test("reports each package once, at the first file that imports it", async () => {
    const { packageRoot, manifest } = await packageWith(
      { name: "@sixb/example" },
      {
        "dist/a.js": 'import { a } from "cmdk/one"\n',
        "dist/b.js": 'import { b } from "cmdk/two"\nimport { c } from "shiki"\n',
      }
    )

    expect(await findUndeclaredImports(packageRoot, manifest, artifactScope)).toEqual([
      { specifier: "cmdk", file: "a.js" },
      { specifier: "shiki", file: "b.js" },
    ])
  })

  test("says nothing about a package that has no such directory", async () => {
    const { packageRoot, manifest } = await packageWith({ name: "@sixb/example" }, {})

    expect(await findUndeclaredImports(packageRoot, manifest, artifactScope)).toEqual([])
  })
})

describe("findAliasDrift", () => {
  test("says nothing while the map names the same file as exports.bun", () => {
    const packages = [
      packageAt("packages/client", "@sixb/client", {
        ".": { bun: "./src/index.ts", import: "./dist/index.js" },
        "./query": { bun: "./src/query.ts", import: "./dist/query.js" },
      }),
    ]

    expect(
      findAliasDrift(packages, {
        "@sixb/client": ["./packages/client/src/index.ts"],
        "@sixb/client/query": ["./packages/client/src/query.ts"],
      })
    ).toEqual([])
  })

  test("reports a subpath the map never learned about", () => {
    // How `@sixb/client/logs` shipped: the subpath existed, the alias did not, and the Atlas
    // bundle resolved it through `exports.import` into a dist that had not been built.
    const packages = [
      packageAt("packages/client", "@sixb/client", {
        ".": { bun: "./src/index.ts", import: "./dist/index.js" },
        "./logs": { bun: "./src/logs.ts", import: "./dist/logs.js" },
      }),
    ]

    expect(
      findAliasDrift(packages, { "@sixb/client": ["./packages/client/src/index.ts"] })
    ).toEqual([
      { specifier: "@sixb/client/logs", expected: "./packages/client/src/logs.ts", actual: null },
    ])
  })

  test("reports a map entry that points somewhere else", () => {
    const packages = [packageAt("storage/pg", "@sixb/pg", { ".": { bun: "./src/index.ts" } })]

    expect(findAliasDrift(packages, { "@sixb/pg": ["./storage/pg/src/client.ts"] })).toEqual([
      {
        specifier: "@sixb/pg",
        expected: "./storage/pg/src/index.ts",
        actual: "./storage/pg/src/client.ts",
      },
    ])
  })

  test("leaves alone what has no source to mirror", () => {
    // `create-sixb` publishes only `dist` and points every condition there, and a stylesheet is
    // not resolved by the module resolver at all.
    const packages = [
      packageAt("packages/create-sixb", "create-sixb", {
        "./scaffold": { bun: "./dist/scaffold.js", import: "./dist/scaffold.js" },
      }),
      packageAt("packages/ui", "@sixb/ui", { "./globals.css": "./src/styles/globals.css" }),
    ]

    expect(findAliasDrift(packages, {})).toEqual([])
  })

  test("keeps a wildcard subpath's fallback list in order", () => {
    const packages = [
      packageAt("packages/ui", "@sixb/ui", {
        "./hooks/*": { bun: ["./src/hooks/*.ts", "./src/hooks/*.tsx"] },
      }),
    ]

    expect(
      findAliasDrift(packages, {
        "@sixb/ui/hooks/*": ["./packages/ui/src/hooks/*.tsx", "./packages/ui/src/hooks/*.ts"],
      })
    ).toEqual([
      {
        specifier: "@sixb/ui/hooks/*",
        expected: "./packages/ui/src/hooks/*.ts, ./packages/ui/src/hooks/*.tsx",
        actual: "./packages/ui/src/hooks/*.tsx, ./packages/ui/src/hooks/*.ts",
      },
    ])
  })
})

function packageAt(
  dir: string,
  name: string,
  exports: Record<string, ExportTarget>
): PublishablePackage {
  return { dir, packageJson: { name, exports } }
}

function patternFor(manifest: ManifestDependencies): RegExp {
  const pattern = siblingSpecifierPattern(manifest)
  if (!pattern) throw new Error("Expected the manifest to declare at least one sibling")
  return pattern
}

interface Fixture {
  readonly packageRoot: string
  readonly manifest: ManifestDependencies
}

async function packageWith(
  manifest: ManifestDependencies,
  files: Record<string, string>
): Promise<Fixture> {
  const packageRoot = await mkdtemp(join(tmpdir(), "sixb-boundaries-"))
  fixtureRoots.push(packageRoot)

  for (const [path, contents] of Object.entries(files)) {
    const target = join(packageRoot, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
  }

  return { packageRoot, manifest }
}
