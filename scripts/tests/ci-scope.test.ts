import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { decideSuite, readWorkspaceGraph, type WorkspaceGraph } from "../ci-scope"

/**
 * A skipped suite is green and silent, so the decision is tested for the ways it can skip what it
 * should have run: an edge it fails to see, and an edge it follows too far is the cheaper mistake.
 *
 * The fixture is one suite with every kind of edge the graph reads:
 *
 *   suite ──dependencies──▶ lib ──import──▶ base
 *     │                      └─tests/──▶ lib-test-only      (another suite's test edge)
 *     ├─tests/ path string──▶ packed
 *     ├─tests/ relative path──▶ helper/tests ──import──▶ helper-dep   (a borrowed helper)
 *     └─tests/ resolve(import.meta.dir, …)──▶ built
 *   unrelated
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
  ].join("\n"),
  // A unit test that reads everything must not widen the suite.
  "packages/suite/tests/boundaries.test.ts": `import "@x/unrelated"`,
  "packages/lib/package.json": json({ name: "@x/lib" }),
  "packages/lib/src/index.ts": `export * from "@x/base"`,
  "packages/lib/tests/helpers.ts": `import "@x/lib-test-only"`,
  "packages/base/package.json": json({ name: "@x/base" }),
  "packages/lib-test-only/package.json": json({ name: "@x/lib-test-only" }),
  "packages/packed/package.json": json({ name: "@x/packed" }),
  "packages/built/package.json": json({ name: "@x/built" }),
  "packages/helper/package.json": json({ name: "@x/helper" }),
  "packages/helper/tests/fixture.ts": `export { fixture } from "@x/helper-dep"`,
  "packages/helper-dep/package.json": json({ name: "@x/helper-dep" }),
  "packages/unrelated/package.json": json({ name: "@x/unrelated" }),
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
    ["the suite's own workspace", "packages/suite/src/index.ts"],
    ["a runtime dependency", "packages/lib/src/index.ts"],
    ["a dependency of a dependency", "packages/base/src/index.ts"],
    ["a workspace a test names by path", "packages/packed/src/index.ts"],
    ["a workspace a test resolves from import.meta.dir", "packages/built/src/index.ts"],
    ["a helper borrowed from another workspace's tests", "packages/helper/tests/fixture.ts"],
    ["what a borrowed helper imports", "packages/helper-dep/src/index.ts"],
  ])("runs when %s changes", (_, path) => {
    expect(decide([path])).toMatchObject({ run: true })
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
      reason: "none of the 7 workspaces @x/suite reaches changed",
    })
  })

  // A dependency's tests never run in this suite, so what only they reach is not reached. Remove
  // the `if (!tests) continue` in `suiteReach` and this fails.
  test("skips what only a dependency's tests reach", () => {
    expect(decide(["packages/lib-test-only/src/index.ts"])).toMatchObject({ run: false })
  })

  test("skips what only a unit test reaches", () => {
    expect(decide(["packages/unrelated/src/index.ts"])).toMatchObject({ run: false })
  })
})

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
