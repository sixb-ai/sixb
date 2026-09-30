import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deploymentLayout } from "../src/layout"
import { renderApplyFiles, renderPrepareScript, renderReceiveScript } from "../src/scripts"
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

async function deployFiles(home: string, files: Record<string, string>): Promise<void> {
  const layout = deploymentLayout({
    home,
    user: "sixb",
    name: "northline",
    projectPath: ".",
    bunVersion: "1.4.2",
  })
  const incoming = join(layout.incomingDir, `upload-${Math.random().toString(16).slice(2)}`)
  await writeTree(incoming, files)
  await new LocalShell().run(renderApplyFiles(layout, incoming))
}

describe("applying an upload", () => {
  test("matches the commit like git reset --hard, keeping what the server made", async () => {
    const home = await tempDir()
    const code = join(home, "northline", "code")

    await deployFiles(home, {
      "package.json": "{}",
      "src/old/one.ts": "one",
      "src/keep.ts": "v1",
    })
    await writeTree(code, {
      ".env": "SECRET=server",
      ".sixb/sixb.db": "data",
      "node_modules/pkg/index.js": "module",
    })

    await deployFiles(home, {
      "package.json": "{}",
      "src/keep.ts": "v2",
      "src/new.ts": "new",
    })

    expect(await tree(code)).toEqual([
      ".env",
      ".sixb/sixb.db",
      "node_modules/pkg/index.js",
      "package.json",
      "src/keep.ts",
      "src/new.ts",
    ])
    expect(await readFile(join(code, "src/keep.ts"), "utf8")).toBe("v2")
  })

  test("never replaces the server's .env with a committed one", async () => {
    const home = await tempDir()
    const code = join(home, "northline", "code")
    await writeTree(code, { ".env": "SECRET=server" })

    await deployFiles(home, { ".env": "SECRET=committed", "app.ts": "app" })

    expect(await readFile(join(code, ".env"), "utf8")).toBe("SECRET=server")
    expect(await tree(code)).toEqual([".env", "app.ts"])
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
    await writeTree(incoming, { "app.ts": "app" })

    const layout = deploymentLayout({
      home,
      user: "sixb",
      name: "northline",
      projectPath: ".",
      bunVersion: "1.4.2",
    })
    await shell.run(renderApplyFiles(layout, incoming))

    // Found on a real server: `code/` took the upload directory's 0700 from `mktemp -d`. Only GNU
    // tar, which Linux (and CI) runs, passes that on; macOS's bsdtar leaves `code/` alone, so
    // removing the `chmod` in renderPrepareScript fails this test on Linux only.
    expect((await stat(layout.code)).mode & 0o050).toBe(0o050)
  })
})
