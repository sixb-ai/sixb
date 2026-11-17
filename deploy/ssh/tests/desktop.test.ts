import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { publishDesktopRelease } from "../src/operations"
import { LocalShell } from "../src/transport"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-deploy-desktop-"))
  tempDirs.push(dir)
  return dir
}

async function release(files: Record<string, string>): Promise<string> {
  const dir = await tempDir()
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

describe("publishing a desktop release", () => {
  test("serves the new release in place of the last, and leaves nothing else behind", async () => {
    const home = await tempDir()
    const shell = new LocalShell({ HOME: home })
    const desktop = join(home, "northline", "desktop")

    await publishDesktopRelease(shell, "northline", {
      platform: "darwin",
      version: "1.0.0",
      dir: await release({ "install.dmg": "v1", "app-1.0.0.zip": "z1", "releases.json": "{}" }),
    })
    await publishDesktopRelease(shell, "northline", {
      platform: "darwin",
      version: "1.1.0",
      dir: await release({ "install.dmg": "v2", "app-1.1.0.zip": "z2", "releases.json": "{}" }),
    })

    expect((await readdir(join(desktop, "darwin"))).sort()).toEqual([
      "app-1.1.0.zip",
      "install.dmg",
      "releases.json",
    ])
    expect(await readFile(join(desktop, "darwin", "install.dmg"), "utf8")).toBe("v2")
    expect(await readdir(desktop)).toEqual(["darwin"])
  })

  test("leaves another system's release as it was", async () => {
    const home = await tempDir()
    const shell = new LocalShell({ HOME: home })
    const desktop = join(home, "northline", "desktop")
    await mkdir(join(desktop, "win32"), { recursive: true })
    await writeFile(join(desktop, "win32", "install.exe"), "windows")

    await publishDesktopRelease(shell, "northline", {
      platform: "darwin",
      version: "1.0.0",
      dir: await release({ "install.dmg": "mac" }),
    })

    expect((await readdir(desktop)).sort()).toEqual(["darwin", "win32"])
    expect(await readFile(join(desktop, "win32", "install.exe"), "utf8")).toBe("windows")
  })
})
