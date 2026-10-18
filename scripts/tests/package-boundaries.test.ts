import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type AliasDrift,
  artifactScope,
  declarationScope,
  findAliasDrift,
  findUndeclaredImports,
  type ImportScope,
  type ManifestDependencies,
  siblingSpecifierPattern,
  sourceScope,
  type UndeclaredImport,
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
  test.each<{
    name: string
    manifest: ManifestDependencies
    matches: string[]
    misses: string[]
  }>([
    {
      name: "matches a sibling whole and at every subpath",
      manifest: { dependencies: { "@sixb/ui": "workspace:*" } },
      matches: ["@sixb/ui", "@sixb/ui/button", "@sixb/ui/components/ui/chart"],
      misses: [],
    },
    {
      // The reason this is a regexp and not an `external: ["@sixb/cli*"]` pattern: that glob also
      // catches `@sixb/client`, and externalizing a package this one does not depend on emits an
      // import nothing installs.
      name: "never matches a package whose name merely starts the same",
      manifest: { dependencies: { "@sixb/cli": "workspace:*" } },
      matches: ["@sixb/cli"],
      misses: ["@sixb/client", "@sixb/client/browser"],
    },
    {
      name: "covers every dependency field and leaves third-party packages alone",
      manifest: {
        dependencies: { "@sixb/core": "workspace:*", tailwindcss: "^4.1.18" },
        peerDependencies: { "@sixb/client": "workspace:*", react: "^19.0.0" },
        optionalDependencies: { "create-sixb": "workspace:*" },
      },
      matches: ["@sixb/core/agents/context", "@sixb/client/browser", "create-sixb/scaffold"],
      misses: ["tailwindcss", "react"],
    },
  ])("$name", ({ manifest, matches, misses }) => {
    const pattern = siblingSpecifierPattern(manifest)
    if (!pattern) throw new Error("Expected the manifest to declare at least one sibling")

    expect(matches.filter((specifier) => !pattern.test(specifier))).toEqual([])
    expect(misses.filter((specifier) => pattern.test(specifier))).toEqual([])
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
  test.each<{
    name: string
    manifest: ManifestDependencies
    files: Record<string, string>
    scope: ImportScope
    undeclared: UndeclaredImport[]
  }>([
    {
      name: "reports a bare import the manifest never declared",
      manifest: { name: "@sixb/example", dependencies: { "@sixb/core": "workspace:*" } },
      files: {
        "src/index.ts": 'import { thing } from "@sixb/core"\nimport { other } from "recharts"\n',
      },
      scope: sourceScope,
      undeclared: [{ specifier: "recharts", file: "index.ts" }],
    },
    {
      name: "accepts declared packages, their subpaths, relative paths, builtins, and self-reference",
      manifest: {
        name: "@sixb/example",
        dependencies: { "@sixb/core": "workspace:*" },
        peerDependencies: { react: "^19.0.0" },
      },
      files: {
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
      },
      scope: sourceScope,
      undeclared: [],
    },
    {
      name: "ignores type-only imports, which resolve against devDependencies legitimately",
      manifest: { name: "@sixb/example" },
      files: {
        "src/index.ts": [
          'import type { Database } from "@sixb/sqlite"',
          'export type { Row } from "@sixb/sqlite"',
          "export type Alias = Database",
          "",
        ].join("\n"),
      },
      scope: sourceScope,
      undeclared: [],
    },
    {
      // Regression proof: Bun.Transpiler.scanImports erases all three type-only specifiers below.
      name: "reports type dependencies exposed by published declarations",
      manifest: { name: "@sixb/example", peerDependencies: { "@sixb/core": "workspace:^" } },
      files: {
        "dist/index.d.ts": [
          'import type { Core } from "@sixb/core"',
          'export type { Database } from "@sixb/sqlite"',
          'export type Queue = import("@sixb/queues-bullmq").Queue',
          "export type Example = Core",
          "",
        ].join("\n"),
      },
      scope: declarationScope,
      undeclared: [
        { specifier: "@sixb/queues-bullmq", file: "index.d.ts" },
        { specifier: "@sixb/sqlite", file: "index.d.ts" },
      ],
    },
    {
      // `@sixb/app` generates a custom-app entry as source text. A regex reads those lines as this
      // package's own imports; a parser does not.
      name: "does not read import statements out of a template literal",
      manifest: { name: "@sixb/example" },
      files: {
        "src/index.ts": [
          "export const generated = `",
          'import { signOut } from "@sixb/client"',
          "`",
          "",
        ].join("\n"),
      },
      scope: sourceScope,
      undeclared: [],
    },
    {
      name: "parses an artifact behind a shebang",
      manifest: { name: "@sixb/example" },
      files: { "dist/cli.js": '#!/usr/bin/env bun\nimport { render } from "ink"\n' },
      scope: artifactScope,
      undeclared: [{ specifier: "ink", file: "cli.js" }],
    },
    {
      name: "reports each package once, at the lexically first file that imports it",
      manifest: { name: "@sixb/example" },
      files: {
        "dist/a.js": 'import { a } from "cmdk/one"\n',
        "dist/b.js": 'import { b } from "cmdk/two"\nimport { c } from "shiki"\n',
      },
      scope: artifactScope,
      undeclared: [
        { specifier: "cmdk", file: "a.js" },
        { specifier: "shiki", file: "b.js" },
      ],
    },
    {
      name: "says nothing about a package that has no such directory",
      manifest: { name: "@sixb/example" },
      files: {},
      scope: artifactScope,
      undeclared: [],
    },
  ])("$name", async ({ manifest, files, scope, undeclared }) => {
    const packageRoot = await packageWith(files)

    expect(await findUndeclaredImports(packageRoot, manifest, scope)).toEqual(undeclared)
  })
})

describe("findAliasDrift", () => {
  test.each<{
    name: string
    packages: PublishablePackage[]
    paths: Record<string, string[]>
    drift: AliasDrift[]
  }>([
    {
      name: "says nothing while the map names the same file as exports.bun",
      packages: [
        packageAt("packages/client", "@sixb/client", {
          ".": { bun: "./src/index.ts", import: "./dist/index.js" },
          "./query": { bun: "./src/query.ts", import: "./dist/query.js" },
        }),
      ],
      paths: {
        "@sixb/client": ["./packages/client/src/index.ts"],
        "@sixb/client/query": ["./packages/client/src/query.ts"],
      },
      drift: [],
    },
    {
      // How `@sixb/client/logs` shipped: the subpath existed, the alias did not, and a browser
      // bundle resolved it through `exports.import` into a dist that had not been built.
      name: "reports a subpath the map never learned about",
      packages: [
        packageAt("packages/client", "@sixb/client", {
          ".": { bun: "./src/index.ts", import: "./dist/index.js" },
          "./logs": { bun: "./src/logs.ts", import: "./dist/logs.js" },
        }),
      ],
      paths: { "@sixb/client": ["./packages/client/src/index.ts"] },
      drift: [
        { specifier: "@sixb/client/logs", expected: "./packages/client/src/logs.ts", actual: null },
      ],
    },
    {
      name: "reports a map entry that points somewhere else",
      packages: [packageAt("storage/pg", "@sixb/pg", { ".": { bun: "./src/index.ts" } })],
      paths: { "@sixb/pg": ["./storage/pg/src/client.ts"] },
      drift: [
        {
          specifier: "@sixb/pg",
          expected: "./storage/pg/src/index.ts",
          actual: "./storage/pg/src/client.ts",
        },
      ],
    },
    {
      // `create-sixb` publishes only `dist` and points every condition there, and a stylesheet is
      // not resolved by the module resolver at all.
      name: "leaves alone what has no source to mirror",
      packages: [
        packageAt("packages/create-sixb", "create-sixb", {
          "./scaffold": { bun: "./dist/scaffold.js", import: "./dist/scaffold.js" },
        }),
        packageAt("packages/ui", "@sixb/ui", { "./globals.css": "./src/styles/globals.css" }),
      ],
      paths: {},
      drift: [],
    },
    {
      name: "keeps a wildcard subpath's fallback list in order",
      packages: [
        packageAt("packages/ui", "@sixb/ui", {
          "./hooks/*": { bun: ["./src/hooks/*.ts", "./src/hooks/*.tsx"] },
        }),
      ],
      paths: {
        "@sixb/ui/hooks/*": ["./packages/ui/src/hooks/*.tsx", "./packages/ui/src/hooks/*.ts"],
      },
      drift: [
        {
          specifier: "@sixb/ui/hooks/*",
          expected: "./packages/ui/src/hooks/*.ts, ./packages/ui/src/hooks/*.tsx",
          actual: "./packages/ui/src/hooks/*.tsx, ./packages/ui/src/hooks/*.ts",
        },
      ],
    },
  ])("$name", ({ packages, paths, drift }) => {
    expect(findAliasDrift(packages, paths)).toEqual(drift)
  })
})

function packageAt(
  dir: string,
  name: string,
  exports: Record<string, ExportTarget>
): PublishablePackage {
  return { dir, packageJson: { name, exports } }
}

async function packageWith(files: Record<string, string>): Promise<string> {
  const packageRoot = await mkdtemp(join(tmpdir(), "sixb-boundaries-"))
  fixtureRoots.push(packageRoot)

  for (const [path, contents] of Object.entries(files)) {
    const target = join(packageRoot, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
  }

  return packageRoot
}
