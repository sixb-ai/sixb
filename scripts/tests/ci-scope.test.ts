import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { decideSuite, readWorkspaceGraph, type WorkspaceGraph } from "../ci-scope"

/**
 * A skipped suite is green and silent, so the decision is tested mostly for the ways it could skip
 * what it should have run: one fixture suite reaches a workspace through every kind of edge the
 * graph reads, and a change to each of them must run it.
 */

let root: string
let graph: WorkspaceGraph

const files: Record<string, string> = {
  "package.json": json({ workspaces: ["packages/*"] }),
  "packages/suite/package.json": json({
    name: "@x/suite",
    dependencies: { "@x/lib": "workspace:*" },
    scripts: { "test:e2e": "bun test ./tests/run.e2e.ts" },
  }),
  "packages/suite/tests/run.e2e.ts": [
    `import { fixture } from "../../helper/tests/fixture"`,
    `const packed = ["packages/packed"]`,
    `const built = resolve(import.meta.dir, "..", "..", "built")`,
    `const paired = join(repoRoot, "packages", "paired")`,
    // A name in test code is not an edge: here it is excluded, not used.
    `for (const entry of entries) if (entry === "@x/excluded") continue`,
  ].join("\n"),
  "packages/suite/template/package.json": json({ dependencies: { "@x/templated": "^1.0.0" } }),
  "packages/suite/src/bin.ts": `#!/usr/bin/env bun\nimport "@x/shebang-dep"\n`,
  // An angle-bracket assertion only parses as TypeScript, not TSX.
  "packages/suite/src/cast.ts": `import { value } from "@x/cast-dep"\nexport const s = <string>value\n`,
  // A unit test that reads everything must not widen the suite.
  "packages/suite/tests/boundaries.test.ts": `import "@x/unrelated"`,
  "packages/lib/package.json": json({ name: "@x/lib" }),
  "packages/lib/src/index.ts": `export * from "@x/base"`,
  "packages/lib/tests/helpers.ts": `import "@x/lib-test-only"`,
  "packages/helper/package.json": json({ name: "@x/helper" }),
  "packages/helper/tests/fixture.ts": `export { fixture } from "@x/helper-dep"`,
  ...Object.fromEntries(
    [
      "base",
      "lib-test-only",
      "packed",
      "built",
      "paired",
      "templated",
      "shebang-dep",
      "cast-dep",
      "helper-dep",
      "excluded",
      "unrelated",
    ].map((name) => [`packages/${name}/package.json`, json({ name: `@x/${name}` })])
  ),
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ci-scope-"))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  graph = await readWorkspaceGraph(root)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function decide(changedPaths: readonly string[] | null, suite = "@x/suite") {
  return decideSuite({ graph, suite, changedPaths })
}

describe("decideSuite", () => {
  test.each([
    ["the suite's own workspace", "suite"],
    ["a manifest dependency", "lib"],
    ["a dependency of a dependency", "base"],
    ["what a dependency's tests import, since every edge is followed", "lib-test-only"],
    ["a workspace a test names by path", "packed"],
    ["a workspace a test resolves from import.meta.dir", "built"],
    ["a workspace a test joins from path segments", "paired"],
    ["a helper imported from another workspace's tests", "helper"],
    ["what that helper imports", "helper-dep"],
    ["a package a template's manifest names", "templated"],
    // Both parse once the loader suits the file; were they rejected, the package names they spell
    // would still count.
    ["an import in a file that starts with #!", "shebang-dep"],
    ["an import in a .ts file that is not valid TSX", "cast-dep"],
  ])("runs when %s changes", (_, workspace) => {
    expect(decide([`packages/${workspace}/src/index.ts`])).toMatchObject({ run: true })
  })

  test.each([
    ["the lockfile", "bun.lock"],
    ["a root config", "tsconfig.json"],
    ["a workflow", ".github/workflows/ci.yml"],
    ["a file between workspaces", "packages/README.md"],
  ])("runs when %s changes, because nothing proves it unrelated", (_, path) => {
    expect(decide(["packages/unrelated/src/index.ts", path])).toEqual({
      run: true,
      reason: `${path} is outside every workspace`,
    })
  })

  test("runs when git could not list the changed files", () => {
    expect(decide(null)).toMatchObject({ run: true })
  })

  test("runs a suite it does not know", () => {
    expect(decide(["packages/unrelated/src/index.ts"], "@x/renamed")).toEqual({
      run: true,
      reason: "@x/renamed is not a workspace",
    })
  })

  test("skips when only unrelated workspaces and documentation changed", () => {
    expect(decide(["packages/unrelated/src/index.ts", "docs/guide.md", "README.md"])).toEqual({
      run: false,
      reason: "none of the 12 workspaces @x/suite reaches changed",
    })
  })

  test("skips what only a unit test imports", () => {
    expect(decide(["packages/unrelated/src/index.ts"])).toMatchObject({ run: false })
  })

  test("skips a package test code only names in a string", () => {
    expect(decide(["packages/excluded/src/index.ts"])).toMatchObject({ run: false })
  })
})

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
