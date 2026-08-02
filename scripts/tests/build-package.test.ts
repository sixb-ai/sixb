import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The one thing `package-boundaries.test.ts` cannot check: that the bundler is actually handed the
 * boundaries, and that they hold against a real resolution.
 *
 * The fixture reproduces the trigger rather than either incident. Both failures need something to
 * resolve a package specifier to a file, which here — as in the repo — is a `tsconfig.json`
 * `paths` entry pointing at a sibling's source. Drop the `paths` block and the build is correct
 * either way; that is the control, and it is why the block is not incidental setup.
 *
 * Each test names the line to delete to watch it fail. One of them needs Bun 1.3.14
 * (`.bun-version`) to reach its trigger at all; the other fails on any version. That difference is
 * the reason the release gate asserts on the artifact and does not rely on these tests alone.
 */

const buildPackageScript = join(import.meta.dir, "..", "build-package.ts")
const fixtureRoots: string[] = []

afterEach(async () => {
  while (fixtureRoots.length > 0) {
    const fixtureRoot = fixtureRoots.pop()
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  }
})

describe("build-package", () => {
  test("keeps a sibling external even when an alias resolves it to source", async () => {
    const { output } = await buildFixture()

    // Delete `plugins: workspaceBoundaryPlugins(...)` from `build-package.ts` to watch these fail.
    // Bun 1.3.8 resolved through `packages: "external"` before it consulted `paths`, so this
    // passes either way there; 1.3.14 is where the alias wins and the sibling gets absorbed.
    expect(output).toContain('from "@sixb/fixture-dependency"')
    expect(output).toContain('from "@sixb/fixture-dependency/subpath"')
    expect(output).not.toContain('from "fixture-third-party"')
    expect(output).not.toContain('subpathValue = "subpath"')
  }, 20_000)

  test("stops the alias at dist, so a consumer bundles the built sibling", async () => {
    const { browserBundle } = await buildFixture()

    // Delete `writeResolutionBoundary(distRoot)` from `build-package.ts` to watch these fail: the
    // consumer's own `paths` map reaches inside its dist and the bundle follows the alias into
    // source that the build never saw. Fails on 1.3.8 and 1.3.14 alike.
    expect(browserBundle).not.toContain("source-only-after-build")
    expect(browserBundle).toContain('thirdPartyValue = "root"')
  }, 20_000)
})

interface BuiltFixture {
  /** The consumer's own artifact, as `build-package.ts` emitted it. */
  readonly output: string
  /** That artifact bundled the way a browser consumer would, one resolution step further out. */
  readonly browserBundle: string
}

/**
 * A consumer and a sibling, built in that order, with the sibling's source changed in between.
 *
 * The change is the marker: after it, `dependency/src` and `dependency/dist` say different things,
 * so a bundle names which of the two it resolved. `fixture-third-party` is a workspace member
 * because the built path has to stay resolvable to prove anything — an absorbed copy is caught by
 * the specifier it leaves behind, not by failing to resolve.
 */
async function buildFixture(): Promise<BuiltFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sixb-package-build-"))
  fixtureRoots.push(fixtureRoot)

  const consumerRoot = join(fixtureRoot, "packages", "consumer")
  const dependencyRoot = join(fixtureRoot, "packages", "dependency")
  const thirdPartyRoot = join(fixtureRoot, "packages", "third-party")
  await mkdir(join(consumerRoot, "src"), { recursive: true })
  await mkdir(join(dependencyRoot, "src"), { recursive: true })
  await mkdir(thirdPartyRoot, { recursive: true })

  await writeJson(join(fixtureRoot, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
  })

  await writeJson(join(consumerRoot, "package.json"), {
    name: "@sixb/fixture-consumer",
    type: "module",
    exports: {
      ".": { bun: "./src/index.ts", import: "./dist/index.js" },
    },
    dependencies: { "@sixb/fixture-dependency": "workspace:*" },
  })
  await writeJson(join(consumerRoot, "tsconfig.json"), {
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "bundler",
      target: "ES2022",
      // The trigger. Bun reads the tsconfig next to the file it is resolving from, so neither the
      // build nor a consumer of the build can opt out of this map from the call site.
      paths: {
        "@sixb/fixture-dependency": ["../dependency/src/index.ts"],
        "@sixb/fixture-dependency/subpath": ["../dependency/src/subpath.ts"],
      },
    },
  })
  await writeFile(
    join(consumerRoot, "src", "index.ts"),
    [
      'export { rootValue } from "@sixb/fixture-dependency"',
      'export { subpathValue } from "@sixb/fixture-dependency/subpath"',
      "",
    ].join("\n")
  )

  await writeJson(join(dependencyRoot, "package.json"), {
    name: "@sixb/fixture-dependency",
    type: "module",
    exports: {
      ".": { bun: "./src/index.ts", import: "./dist/index.js" },
      "./subpath": { bun: "./src/subpath.ts", import: "./dist/subpath.js" },
    },
    dependencies: { "fixture-third-party": "workspace:*" },
  })
  await writeFile(join(dependencyRoot, "src", "index.ts"), 'export { rootValue } from "./value"\n')
  await writeFile(
    join(dependencyRoot, "src", "value.ts"),
    [
      'import { thirdPartyValue } from "fixture-third-party"',
      "export const rootValue = thirdPartyValue",
      "",
    ].join("\n")
  )
  await writeFile(
    join(dependencyRoot, "src", "subpath.ts"),
    'export const subpathValue = "subpath"\n'
  )
  await writeJson(join(thirdPartyRoot, "package.json"), {
    name: "fixture-third-party",
    type: "module",
    exports: "./index.js",
  })
  await writeFile(join(thirdPartyRoot, "index.js"), 'export const thirdPartyValue = "root"\n')

  await runBounded([process.execPath, "install"], fixtureRoot)

  await runBounded([process.execPath, "run", buildPackageScript], dependencyRoot)
  await writeFile(
    join(dependencyRoot, "src", "value.ts"),
    'export const rootValue = "source-only-after-build"\n'
  )
  await runBounded([process.execPath, "run", buildPackageScript], consumerRoot)

  const browserBundlePath = join(fixtureRoot, "browser.js")
  const browserBuildScript = join(fixtureRoot, "build-browser.ts")
  await writeFile(
    browserBuildScript,
    [
      `const result = await Bun.build({ entrypoints: [${JSON.stringify(join(consumerRoot, "dist", "index.js"))}], target: "browser" })`,
      'if (!result.success) throw new Error(result.logs.map(String).join("\\n"))',
      `await Bun.write(${JSON.stringify(browserBundlePath)}, result.outputs[0])`,
      "",
    ].join("\n")
  )
  await runBounded([process.execPath, "run", browserBuildScript], fixtureRoot)

  return {
    output: await readFile(join(consumerRoot, "dist", "index.js"), "utf-8"),
    browserBundle: await readFile(browserBundlePath, "utf-8"),
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * The unit suite fails at 60 seconds of silence and cannot tell a wedged child from a slow one,
 * so the child gets a bound of its own and says which it was.
 */
async function runBounded(command: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, 15_000)

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timer)

  if (timedOut) throw new Error(`Command timed out after 15s: ${command.join(" ")}`)
  if (exitCode !== 0) {
    throw new Error(`Command failed (${command.join(" ")}):\n${stdout}${stderr}`.trim())
  }
}
