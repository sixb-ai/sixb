import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deploymentLayout, releaseLayout } from "../src/layout"
import {
  renderPrepareRelease,
  renderPrepareScript,
  renderPruneReleases,
  renderReceiveScript,
} from "../src/scripts"
import { LocalShell } from "../src/transport"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-deploy-ssh-"))
  tempDirs.push(dir)
  return dir
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

/** Lists every file under a directory, relative to it. */
async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort()
}

describe("preparing a release directory", () => {
  test("migrates an in-place code folder, isolates each release, and preserves the server's .env", async () => {
    const home = await tempDir()
    const layout = deploymentLayout({
      home,
      user: "sixb",
      name: "northline",
      projectPath: ".",
      bunVersion: "1.4.2",
    })
    // Seed a legacy deployment where `code/` is a plain directory holding `.env`.
    await writeTree(layout.code, {
      ".env": "SECRET=server",
      "package.json": "{}",
      "src/old.ts": "v1",
    })

    const r1 = releaseLayout(layout, "r1")
    const incoming1 = join(layout.incomingDir, "upload-r1")
    await writeTree(incoming1, {
      ".env": "SECRET=committed",
      "package.json": "{}",
      "src/new.ts": "v2",
    })
    await new LocalShell().run(renderPrepareRelease(layout, r1, incoming1))

    expect((await lstat(layout.code)).isSymbolicLink()).toBe(true)
    expect(await tree(join(layout.releasesDir, "legacy"))).toContain("src/old.ts")
    expect(await tree(r1.root)).toEqual([".env", "package.json", "src/new.ts"])
    expect(await readFile(join(r1.root, ".env"), "utf8")).toBe("SECRET=server")
    expect(await readFile(layout.sharedEnv, "utf8")).toBe("SECRET=server")
  })

  test("prunes older releases while keeping current, previous, and any retiring release", async () => {
    const home = await tempDir()
    const layout = deploymentLayout({
      home,
      user: "sixb",
      name: "northline",
      projectPath: ".",
      bunVersion: "1.4.2",
    })
    for (const id of ["r1", "r2", "r3", "r4"]) {
      await mkdir(join(layout.releasesDir, id), { recursive: true })
    }
    await mkdir(layout.runDir, { recursive: true })
    await writeFile(
      join(layout.runDir, "state.json"),
      JSON.stringify({ retiringCwds: [join(layout.releasesDir, "r1")] })
    )
    await symlink("releases/r4", layout.currentLink)

    const script = [
      `RELEASES_DIR=${JSON.stringify(layout.releasesDir)}`,
      `RELEASE_ID="r4"`,
      `prev_release="r3"`,
      `STATE_FILE=${JSON.stringify(join(layout.runDir, "state.json"))}`,
      renderPruneReleases(),
    ].join("\n")
    await new LocalShell().run(script)

    expect((await readdir(layout.releasesDir)).sort()).toEqual(["r1", "r3", "r4"])
  })
})

describe("uploading the source", () => {
  test("extracts each archive where it belongs under a fresh upload directory", async () => {
    const home = await tempDir()
    const shell = new LocalShell({ HOME: home })
    const lines: string[] = []
    await shell.run(renderPrepareScript("northline", "abcdef1234567890"), {
      onLine: (line) => lines.push(line),
    })
    const [reportedHome, incoming] = lines
    expect(reportedHome).toBe(home)
    expect(incoming).toStartWith(join(home, "northline/deploy/incoming/abcdef123456."))

    const source = await tempDir()
    await writeTree(source, { "root.ts": "root", "vendor/lib/index.ts": "lib" })
    for (const [path, from] of [
      [".", "root.ts"],
      ["vendor/lib", "index.ts"],
    ] as const) {
      const directory = path === "." ? source : join(source, path)
      const archive = Bun.spawn(["tar", "-c", "-f", "-", from], { cwd: directory }).stdout
      await shell.run(renderReceiveScript(incoming ?? "", path), { stdin: archive })
    }

    expect(await tree(incoming ?? "")).toEqual(["root.ts", "vendor/lib/index.ts"])
  })

  test("leaves the code readable by the admin, who reads it through the deploy user's group", async () => {
    const home = await tempDir()
    const shell = new LocalShell({ HOME: home })
    const lines: string[] = []
    await shell.run(renderPrepareScript("northline", "abcdef1234567890"), {
      onLine: (line) => lines.push(line),
    })
    const incoming = lines[1] ?? ""
    const layout = deploymentLayout({
      home,
      user: "sixb",
      name: "northline",
      projectPath: ".",
      bunVersion: "1.4.2",
    })
    const target = releaseLayout(layout, "r1")
    const source = await tempDir()
    await writeTree(source, { "index.ts": "" })
    const archive = Bun.spawn(["tar", "-c", "-f", "-", "."], { cwd: source }).stdout
    await shell.run(renderReceiveScript(incoming, "."), { stdin: archive })
    await shell.run(renderPrepareRelease(layout, target, incoming))

    const stats = await lstat(target.root)
    expect(stats.mode & 0o050).toBe(0o050)
  })
})
