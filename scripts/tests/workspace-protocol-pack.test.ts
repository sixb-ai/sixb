import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertWorkspaceLockfileVersions } from "../workspace-lockfile-policy"

test("Bun packs exact and compatible workspace protocols to registry ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "sixb-workspace-protocols-"))

  try {
    await writeJson(join(root, "package.json"), {
      name: "workspace-protocol-fixture",
      private: true,
      workspaces: ["packages/*"],
    })
    await writePackage(root, "core", {
      name: "@sixb-fixture/core",
      version: "0.1.7",
    })
    await writePackage(root, "compatible", {
      name: "@sixb-fixture/compatible",
      version: "0.1.0",
      dependencies: { "@sixb-fixture/core": "workspace:^" },
    })
    await writePackage(root, "exact", {
      name: "@sixb-fixture/exact",
      version: "0.1.0",
      peerDependencies: { "@sixb-fixture/core": "workspace:*" },
      devDependencies: { "@sixb-fixture/core": "workspace:*" },
    })

    await run([process.execPath, "install", "--lockfile-only"], root)

    const [compatible, exact] = await Promise.all([
      packManifest(root, "compatible"),
      packManifest(root, "exact"),
    ])
    expect(compatible.dependencies).toEqual({ "@sixb-fixture/core": "^0.1.7" })
    expect(exact.peerDependencies).toEqual({ "@sixb-fixture/core": "0.1.7" })

    // A frozen install accepts a version-only bump without refreshing bun.lock. Bun 1.3.14–1.4.2
    // then packed the old lockfile version; 1.4.4 packs the manifest's. Remove the version
    // comparison in assertWorkspaceLockfileVersions and the rejection below fails, proving the
    // release gate catches the stale lockfile whichever Bun packs the release.
    const core = { name: "@sixb-fixture/core", version: "0.1.8" }
    await writePackage(root, "core", core)
    const packages = [{ dir: "packages/core", packageJson: core }]
    await run([process.execPath, "install", "--frozen-lockfile"], root)
    await expect(assertWorkspaceLockfileVersions(root, packages)).rejects.toThrow(
      "manifest 0.1.8, lockfile 0.1.7"
    )

    await run([process.execPath, "install", "--lockfile-only"], root)
    await assertWorkspaceLockfileVersions(root, packages)
    const [refreshedExact, refreshedCompatible] = await Promise.all([
      packManifest(root, "exact"),
      packManifest(root, "compatible"),
    ])
    expect(refreshedExact.peerDependencies).toEqual({ "@sixb-fixture/core": "0.1.8" })
    expect(refreshedCompatible.dependencies).toEqual({ "@sixb-fixture/core": "^0.1.8" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function writePackage(
  root: string,
  directory: string,
  manifest: Readonly<Record<string, unknown>>
): Promise<void> {
  const packageRoot = join(root, "packages", directory)
  await mkdir(packageRoot, { recursive: true })
  await writeJson(join(packageRoot, "package.json"), manifest)
  await writeFile(join(packageRoot, "index.js"), "export {}\n")
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function packManifest(
  root: string,
  directory: string
): Promise<{
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}> {
  const packageRoot = join(root, "packages", directory)
  const destination = join(root, "artifacts", directory)
  await mkdir(destination, { recursive: true })

  await run([process.execPath, "pm", "pack", "--destination", destination, "--quiet"], packageRoot)

  const tarball = (await readdir(destination)).find((file) => file.endsWith(".tgz"))
  if (!tarball) throw new Error(`Pack output for ${directory} did not contain a tarball.`)

  return JSON.parse(
    await run(["tar", "-xOf", join(destination, tarball), "package/package.json"], root)
  )
}

/**
 * Async and bounded: a synchronous spawn in a parallel test worker can miss its child's exit and
 * leave the worker spinning with a zombie `bun` or `tar` until the CI guard kills the run.
 */
async function run(command: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill("SIGKILL"), 4_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(`${command.join(" ")} exited ${exitCode}:\n${stderr}`)
    return stdout
  } finally {
    clearTimeout(timer)
  }
}
