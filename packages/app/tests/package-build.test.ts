import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "../../..")
const buildPackageScript = join(repoRoot, "scripts", "build-package.ts")

describe("package build workspace boundaries", () => {
  let fixtureRoot = ""

  afterEach(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  })

  test("keeps workspace dependencies and their subpaths external", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "sixb-package-build-"))
    const consumerRoot = join(fixtureRoot, "packages", "consumer")
    const dependencyRoot = join(fixtureRoot, "packages", "dependency")

    await mkdir(join(consumerRoot, "src"), { recursive: true })
    await mkdir(join(dependencyRoot, "src"), { recursive: true })
    await writeJson(join(fixtureRoot, "package.json"), {
      private: true,
      workspaces: ["packages/*"],
    })
    await writeJson(join(consumerRoot, "package.json"), {
      name: "@sixb/fixture-consumer",
      type: "module",
      exports: {
        ".": {
          bun: "./src/index.ts",
          import: "./dist/index.js",
        },
      },
      dependencies: {
        "@sixb/fixture-dependency": "workspace:*",
      },
    })
    await writeJson(join(consumerRoot, "tsconfig.json"), {
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "bundler",
        target: "ES2022",
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
        ".": {
          bun: "./src/index.ts",
          import: "./dist/index.js",
        },
        "./subpath": {
          bun: "./src/subpath.ts",
          import: "./dist/subpath.js",
        },
      },
    })
    await writeFile(
      join(dependencyRoot, "src", "index.ts"),
      'export { rootValue } from "./value"\n'
    )
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

    await runBounded([process.execPath, "install"], fixtureRoot)
    const thirdPartyRoot = join(dependencyRoot, "node_modules", "fixture-third-party")
    await mkdir(thirdPartyRoot, { recursive: true })
    await writeJson(join(thirdPartyRoot, "package.json"), {
      name: "fixture-third-party",
      type: "module",
      exports: "./index.js",
    })
    await writeFile(join(thirdPartyRoot, "index.js"), 'export const thirdPartyValue = "root"\n')
    await runBounded([process.execPath, "run", buildPackageScript], consumerRoot)

    const output = await readFile(join(consumerRoot, "dist", "index.js"), "utf-8")
    expect(output).toContain('from "@sixb/fixture-dependency"')
    expect(output).toContain('from "@sixb/fixture-dependency/subpath"')
    expect(output).not.toContain('from "fixture-third-party"')
    expect(output).not.toContain('subpathValue = "subpath"')
  }, 20_000)
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function runBounded(command: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timer)

  if (exitCode !== 0) {
    throw new Error(`Command failed (${command.join(" ")}):\n${stdout}${stderr}`.trim())
  }
}
