import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import * as desktop from "@sixb/desktop"
import {
  deployedOrigins,
  needsRelease,
  runDesktopRelease,
  runDesktopStatus,
} from "../src/commands/desktop"
import { DESKTOP_RUNNER_ENTRY, loadDesktop, type SixbDesktop } from "../src/lib/desktop"
import { runDevSupervisor } from "../src/lib/dev-supervisor"

const supervisor = resolve(import.meta.dir, "../src/lib/dev-supervisor.ts")
const deployProject = resolve(import.meta.dir, "fixtures", "deploy-project")
const ORIGIN_ENV = ["SIXB_APP_PUBLIC_ORIGIN", "SIXB_API_PUBLIC_ORIGIN"] as const

const tempDirs: string[] = []
const savedEnv = ORIGIN_ENV.map((name) => [name, process.env[name]] as const)

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-desktop-"))
  tempDirs.push(dir)
  return dir
}

/** Installs a stand-in `@sixb/desktop` in `root`, exporting `source`. */
async function installDesktopStub(root: string, source: string): Promise<void> {
  const stub = join(root, "node_modules", "@sixb", "desktop")
  await mkdir(stub, { recursive: true })
  await writeFile(
    join(stub, "package.json"),
    JSON.stringify({ name: "@sixb/desktop", type: "module", main: "index.js" })
  )
  await writeFile(join(stub, "index.js"), source)
}

describe("@sixb/desktop", () => {
  test("is called exactly as it exports", () => {
    // Stops type-checking when the package's functions no longer take what the CLI passes.
    const exported: SixbDesktop = desktop
    expect(Object.keys(exported).sort()).toEqual(["buildDesktopApp", "openDesktopApp"])
  })

  test("loads from the project that installs it", async () => {
    const loaded = await loadDesktop(join(import.meta.dir, ".."))

    expect(typeof loaded.buildDesktopApp).toBe("function")
  })

  test("tells a project without it how to add it", async () => {
    const projectRoot = await tempDir()

    await expect(loadDesktop(projectRoot)).rejects.toMatchObject({
      remediation: "Run `bun add -d @sixb/desktop`, then try again.",
    })
    // `sixb dev --desktop` says so before it starts anything.
    await expect(
      runDevSupervisor({ entry: join(projectRoot, "sixb.config.ts"), desktop: true })
    ).rejects.toMatchObject({ remediation: "Run `bun add -d @sixb/desktop`, then try again." })
  })

  test("refuses a copy that lacks what the CLI calls", async () => {
    const projectRoot = await tempDir()
    await installDesktopStub(projectRoot, "export async function openDesktopApp() {}\n")

    await expect(loadDesktop(projectRoot)).rejects.toMatchObject({
      remediation: "Run `bun add -d @sixb/desktop@latest`, then try again.",
    })
  })
})

describe("sixb dev --desktop", () => {
  // Guard check: open the window on every ready message in dev-supervisor.ts, or drop the close
  // from its shutdown; this then sees two "opened" lines, or no "closed".
  test("opens one window once the app is served, and closes it as dev stops", async () => {
    const root = await tempDir()
    await installDesktopStub(
      root,
      `export async function openDesktopApp(options) {
  console.log(JSON.stringify({ opened: options }))
  return { exited: new Promise(() => {}), close: () => console.log("closed") }
}
export async function buildDesktopApp() {}
`
    )
    await writeFile(join(root, "sixb.config.ts"), "export default null\n")
    await writeFile(
      join(root, "entry.ts"),
      `
import { runDevSupervisor } from ${JSON.stringify(supervisor)}
if (process.env.SIXB_DEV_CHILD === "1") {
  const app = { url: "http://localhost:4321/", apiOrigin: "http://localhost:4322" }
  // A later ready, such as the next generation's, finds the window already open.
  process.send({ type: "ready", watchesApp: false, app })
  process.send({ type: "ready", watchesApp: false, app })
  setTimeout(() => process.kill(process.ppid, "SIGTERM"), 300)
  await new Promise(() => {})
} else {
  await runDevSupervisor({ entry: "./sixb.config.ts", desktop: true })
}
`
    )

    const proc = Bun.spawn([process.execPath, join(root, "entry.ts")], {
      cwd: root,
      env: { ...process.env, SIXB_DEV_CHILD: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(code, stderr).toBe(0)
    const opened = stdout
      .split("\n")
      .filter((line) => line.startsWith('{"opened"'))
      .map((line) => (JSON.parse(line) as { readonly opened: Record<string, string> }).opened)
    expect(opened).toEqual([
      {
        projectRoot: expect.stringMatching(new RegExp(`${basename(root)}$`)),
        appUrl: "http://localhost:4321/",
        apiOrigin: "http://localhost:4322",
        runnerEntry: DESKTOP_RUNNER_ENTRY,
      },
    ])
    expect(stdout).toContain("closed")
  }, 15_000)
})

describe("sixb desktop build", () => {
  test("opens the app where sixb.deploy.ts deploys it", async () => {
    for (const name of ORIGIN_ENV) delete process.env[name]

    expect(await deployedOrigins(deployProject, {})).toEqual({
      app: "https://ops.example.com",
      api: "https://northline-api.example.com",
    })
  })

  test("takes the flags, then the environment, before the deployment", async () => {
    process.env.SIXB_APP_PUBLIC_ORIGIN = "https://env-app.example.com"
    process.env.SIXB_API_PUBLIC_ORIGIN = "https://env-api.example.com"

    expect(
      await deployedOrigins(deployProject, { appPublicOrigin: "https://flag-app.example.com" })
    ).toEqual({ app: "https://flag-app.example.com", api: "https://env-api.example.com" })
  })

  test("says where to name the deployment when nothing does", async () => {
    for (const name of ORIGIN_ENV) delete process.env[name]

    await expect(deployedOrigins(await tempDir(), {})).rejects.toMatchObject({
      remediation:
        "Describe the deployment in sixb.deploy.ts, or set SIXB_APP_PUBLIC_ORIGIN and " +
        "SIXB_API_PUBLIC_ORIGIN.",
    })
  })
})

describe("desktop releases", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** The deployed app, serving `released` as its macOS release, or none. */
  function serveRelease(released: string | null): string[] {
    const asked: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      asked.push(url)
      if (url === "https://ops.example.com/__sixb/desktop/darwin/releases.json" && released) {
        return Response.json({ currentRelease: released, releases: [] })
      }
      return new Response("Not Found", { status: 404 })
    }) as typeof fetch
    return asked
  }

  /**
   * A project at `version` whose deployment records what it's asked to publish, and whose
   * `@sixb/desktop` records what it's asked to build.
   */
  async function releaseProject(version: string): Promise<string> {
    const root = await tempDir()
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "ops", version }))
    await writeFile(
      join(root, "sixb.deploy.ts"),
      `export default {
  name: "northline",
  domain: "example.com",
  services: { app: { domain: "ops.example.com" } },
  target: {
    kind: "test",
    location: "sixb@test-server",
    listenAddress: (service) => ({ host: "127.0.0.1", port: { app: 3001, api: 3002 }[service] }),
    async deploy() {}, async status() {}, async logs() {}, async control() {}, async check() { return [] },
    async publishDesktop(release, context) {
      globalThis.desktopTest.published.push({ release, name: context.name })
    },
  },
}
`
    )
    await installDesktopStub(
      root,
      `export async function openDesktopApp() {}
export async function buildDesktopApp(options) {
  globalThis.desktopTest.built.push(options)
  return { path: "/out/install.dmg", signed: true, release: { platform: "darwin", version: ${JSON.stringify(version)}, dir: "/out" } }
}
`
    )
    return root
  }

  function recorded() {
    const record = { built: [] as Record<string, unknown>[], published: [] as unknown[] }
    ;(globalThis as { desktopTest?: unknown }).desktopTest = record
    return record
  }

  /** What a command wrote with `--json`. */
  async function json(run: () => Promise<void>): Promise<unknown> {
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      await run()
      return JSON.parse(String(write.mock.calls.at(-1)?.[0]))
    } finally {
      write.mockRestore()
    }
  }

  test("releases a version newer than the deployment's, and only that", () => {
    expect(needsRelease(null, "1.0.0", "macOS")).toBe(true)
    expect(needsRelease("1.0.0", "1.1.0", "macOS")).toBe(true)
    expect(needsRelease("1.2.0", "1.10.0", "macOS")).toBe(true)
    // Already out: no failure, so CI can run a release on every commit.
    expect(needsRelease("1.1.0", "1.1.0", "macOS")).toBe(false)
    expect(() => needsRelease("1.2.0", "1.1.0", "macOS")).toThrow(
      "The macOS release is 1.2.0, newer than 1.1.0 in package.json."
    )
  })

  test("shows what the deployment serves beside the version package.json names", async () => {
    const root = await releaseProject("1.2.0")
    serveRelease("1.1.0")

    expect(await json(() => runDesktopStatus({ cwd: root, json: true }))).toEqual({
      version: "1.2.0",
      platforms: [{ platform: "darwin", released: "1.1.0", outdated: true }],
    })
  })

  test("asks for a version before releasing anything", async () => {
    const root = await releaseProject("1.2.0")
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "ops" }))
    serveRelease(null)

    const error = await runDesktopStatus({ cwd: root }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ remediation: 'Set "version" in package.json, such as "1.0.0".' })
  })

  describe.if(process.platform === "darwin")("on macOS", () => {
    // Guard check: drop the version check from runDesktopRelease, and the second release builds
    // and publishes again.
    test("builds a signed release for the deployed app, publishes it, then waits for a new version", async () => {
      const root = await releaseProject("1.2.0")
      const record = recorded()
      serveRelease("1.1.0")

      expect(await json(() => runDesktopRelease({ cwd: root, json: true }))).toEqual({
        platform: "darwin",
        version: "1.2.0",
        released: true,
        download: "https://ops.example.com/__sixb/desktop/darwin/install.dmg",
      })
      expect(record.built).toEqual([
        expect.objectContaining({
          appUrl: "https://ops.example.com",
          apiOrigin: "https://northline-api.example.com",
          requireSignature: true,
        }),
      ])
      expect(record.published).toEqual([
        { release: { platform: "darwin", version: "1.2.0", dir: "/out" }, name: "northline" },
      ])

      serveRelease("1.2.0")
      expect(await json(() => runDesktopRelease({ cwd: root, json: true }))).toMatchObject({
        released: false,
      })
      expect(record.built).toHaveLength(1)
      expect(record.published).toHaveLength(1)
    })
  })
})
