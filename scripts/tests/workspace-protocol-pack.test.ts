import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

    const installed = Bun.spawnSync([process.execPath, "install", "--lockfile-only"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (installed.exitCode !== 0) {
      throw new Error(`Could not install workspace fixture:\n${installed.stderr.toString()}`)
    }

    expect((await packManifest(root, "compatible")).dependencies).toEqual({
      "@sixb-fixture/core": "^0.1.7",
    })
    expect((await packManifest(root, "exact")).peerDependencies).toEqual({
      "@sixb-fixture/core": "0.1.7",
    })
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

  const packed = Bun.spawnSync(
    [process.execPath, "pm", "pack", "--destination", destination, "--quiet"],
    { cwd: packageRoot, stdout: "pipe", stderr: "pipe" }
  )
  if (packed.exitCode !== 0) {
    throw new Error(`Could not pack ${directory}:\n${packed.stderr.toString()}`)
  }

  const tarball = (await readdir(destination)).find((file) => file.endsWith(".tgz"))
  if (!tarball) throw new Error(`Pack output for ${directory} did not contain a tarball.`)

  const manifest = Bun.spawnSync(
    ["tar", "-xOf", join(destination, tarball), "package/package.json"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  if (manifest.exitCode !== 0) {
    throw new Error(`Could not inspect ${tarball}:\n${manifest.stderr.toString()}`)
  }
  return JSON.parse(manifest.stdout.toString())
}
