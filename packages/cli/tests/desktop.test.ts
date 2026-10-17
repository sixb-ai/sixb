import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import * as desktop from "@sixb/desktop"
import { deployedOrigins } from "../src/commands/desktop"
import { loadDesktop, type SixbDesktop } from "../src/lib/desktop"
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
