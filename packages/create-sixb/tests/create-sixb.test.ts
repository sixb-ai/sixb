import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const createPackageDir = join(repoRoot, "packages", "create-sixb")
const cliPackageDir = join(repoRoot, "packages", "cli")

let layoutRoot: string
let runRoot: string
let createEntry: string
let cliEntry: string

beforeAll(async () => {
  layoutRoot = await mkdtemp(join(tmpdir(), "create-sixb-packed-"))
  const artifactsDir = join(layoutRoot, "artifacts")
  const nodeModulesDir = join(layoutRoot, "node_modules")
  runRoot = join(layoutRoot, "run")
  await mkdir(artifactsDir, { recursive: true })
  await mkdir(join(nodeModulesDir, "@sixb", "cli"), { recursive: true })
  await mkdir(join(nodeModulesDir, "create-sixb"), { recursive: true })
  await mkdir(runRoot, { recursive: true })

  const createTarball = packPackage(createPackageDir, artifactsDir)
  const cliTarball = packPackage(cliPackageDir, artifactsDir)
  extractPackage(createTarball, join(nodeModulesDir, "create-sixb"))
  extractPackage(cliTarball, join(nodeModulesDir, "@sixb", "cli"))

  // The packed CLI imports only Ink and React before dispatching `create`. Link those installed
  // third-party dependencies while keeping both Sixb packages isolated from workspace symlinks.
  await linkInstalledDependency("ink", nodeModulesDir)
  await linkInstalledDependency("react", nodeModulesDir)

  createEntry = join(nodeModulesDir, "create-sixb", "dist", "index.js")
  cliEntry = join(nodeModulesDir, "@sixb", "cli", "src", "index.tsx")
})

afterAll(async () => {
  if (layoutRoot) await rm(layoutRoot, { recursive: true, force: true })
})

describe("create-sixb packed artifacts", () => {
  test("publishes the dependency in the correct direction", async () => {
    const createManifest = await readPackageManifest(
      join(layoutRoot, "node_modules", "create-sixb")
    )
    const cliManifest = await readPackageManifest(join(layoutRoot, "node_modules", "@sixb", "cli"))

    expect(createManifest.dependencies).toBeUndefined()
    expect(cliManifest.dependencies?.["create-sixb"]).toBe("0.1.0")
  })

  test("shows the bun create usage", () => {
    const result = runPacked([createEntry, "--help"], runRoot)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("bun create sixb <project-name>")
    expect(result.stderr).toBe("")
  })

  test("creates a project through the zero-dependency launcher", async () => {
    const cwd = await createRunDirectory("launcher")
    const result = runPacked([createEntry, "starter"], cwd)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    await assertScaffold(join(cwd, "starter"), "starter")
  })

  test("creates a project through the packed sixb CLI", async () => {
    const cwd = await createRunDirectory("cli")
    const result = runPacked([cliEntry, "create", "starter-cli"], cwd)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    await assertScaffold(join(cwd, "starter-cli"), "starter-cli")
  })

  test("refuses to merge into a non-empty directory from either command", async () => {
    for (const [command, prefix] of [
      ["launcher-non-empty", [createEntry]],
      ["cli-non-empty", [cliEntry, "create"]],
    ] as const) {
      const cwd = await createRunDirectory(command)
      const target = join(cwd, "existing")
      await mkdir(target)
      await writeFile(join(target, "keep.txt"), "keep\n")

      const result = runPacked([...prefix, "existing"], cwd)

      expect(result.exitCode).toBe(1)
      expect(`${result.stdout}\n${result.stderr}`).toContain("Target directory is not empty")
      expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep\n")
      expect(await Bun.file(join(target, "package.json")).exists()).toBe(false)
    }
  })
})

async function readPackageManifest(packageDir: string): Promise<{
  dependencies?: Record<string, string>
}> {
  return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"))
}

function packPackage(packageDir: string, destination: string): string {
  const result = Bun.spawnSync(["bun", "pm", "pack", "--destination", destination, "--quiet"], {
    cwd: packageDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (result.exitCode !== 0) {
    throw new Error(`Failed to pack ${packageDir}:\n${stdout}${stderr}`)
  }

  const tarball = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.endsWith(".tgz"))
  if (!tarball) throw new Error(`Pack output did not contain a tarball path:\n${stdout}${stderr}`)
  return tarball
}

function extractPackage(tarball: string, destination: string): void {
  const result = Bun.spawnSync(
    ["tar", "-xzf", tarball, "--strip-components=1", "-C", destination],
    { stdout: "pipe", stderr: "pipe" }
  )
  if (result.exitCode !== 0) {
    throw new Error(`Failed to extract ${tarball}:\n${result.stderr.toString()}`)
  }
}

async function linkInstalledDependency(name: string, nodeModulesDir: string): Promise<void> {
  const installed = await realpath(join(cliPackageDir, "node_modules", name))
  await symlink(installed, join(nodeModulesDir, name))
}

async function createRunDirectory(name: string): Promise<string> {
  const directory = join(runRoot, name)
  await mkdir(directory)
  return directory
}

function runPacked(
  args: string[],
  cwd: string
): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const result = Bun.spawnSync(["bun", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

async function assertScaffold(projectDir: string, name: string): Promise<void> {
  await stat(join(projectDir, "sixb.config.ts"))
  await stat(join(projectDir, "app", "page.tsx"))
  await stat(join(projectDir, ".gitignore"))
  expect(await Bun.file(join(projectDir, "gitignore")).exists()).toBe(false)

  const configSource = await readFile(join(projectDir, "sixb.config.ts"), "utf8")
  expect(configSource).toContain(`const projectId = "${name}"`)
  expect(configSource).toContain('new SqliteStorage({ path: ".sixb" })')
  expect(configSource).toContain("new DuckLakeStorage({")
  expect(configSource).toContain('path: ".sixb/lake/metadata.ducklake"')
  expect(configSource).toContain('dataPath: ".sixb/lake/data"')
  expect(configSource).not.toContain("LocalLakeStorage")
  expect(configSource).not.toContain("isProduction")

  const incrementAction = await readFile(join(projectDir, "actions", "increment.ts"), "utf8")
  expect(incrementAction).toContain('defineAction("increment")')
  expect(incrementAction).toContain(".edits(")

  const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")) as {
    name?: string
    dependencies?: Record<string, string>
  }
  expect(packageJson.name).toBe(name)
  expect(packageJson.dependencies?.["@sixb/cli"]).toBe("^0.1.0")
  expect(packageJson.dependencies?.["@sixb/ducklake"]).toBe("^0.1.0")
  expect(packageJson.dependencies?.["@sixb/lake-local"]).toBeUndefined()
}
