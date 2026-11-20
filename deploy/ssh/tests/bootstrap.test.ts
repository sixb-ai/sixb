import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseEvent } from "../src/plan"

const bootstrap = join(import.meta.dir, "../src/bootstrap.sh")
const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A runner exit code the stand-in Bun hands back, and what it printed. */
interface Run {
  readonly exitCode: number
  readonly lines: readonly string[]
  readonly home: string
}

/**
 * Runs the bootstrap in a fresh home with stand-ins for what a server provides: `flock`, and a
 * Bun that installs the two bins a project needs and reports how the runner was started.
 */
async function runBootstrap(
  setup: (home: string, incoming: string) => Promise<void> = async () => {},
  options: { readonly runnerExit?: number; readonly withoutDeployBin?: boolean } = {}
): Promise<Run> {
  const home = await mkdtemp(join(tmpdir(), "sixb-bootstrap-"))
  cleanups.push(home)
  const tools = join(home, "tools")
  const incoming = join(home, "northline", "deploy", "incoming", "r2.abc")
  await mkdir(tools, { recursive: true })
  await mkdir(join(incoming, "app"), { recursive: true })
  await writeFile(join(incoming, "app", "package.json"), "{}")
  await writeFile(join(incoming, "app", ".env"), "COMMITTED=1\n")
  await writeFile(join(tools, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const bunDir = join(home, ".sixb", "bun", "1.4.2")
  await mkdir(bunDir, { recursive: true })
  await writeFile(
    join(bunDir, "bun"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  --version) echo 1.4.2 ;;",
      `  install) mkdir -p node_modules/.bin node_modules/@sixb/deploy-ssh/src/server && touch node_modules/@sixb/deploy-ssh/src/server/release.ts node_modules/.bin/sixb${options.withoutDeployBin ? "" : " node_modules/.bin/sixb-deploy-ssh"} ;;`,
      `  *) echo "runner $*"; exit ${options.runnerExit ?? 0} ;;`,
      "esac",
    ].join("\n"),
    { mode: 0o755 }
  )
  await setup(home, incoming)

  const child = Bun.spawn(
    ["bash", bootstrap, "northline", "r2", "app", "1.4.2", incoming, "/plan.json"],
    {
      env: { HOME: home, PATH: `${tools}:${process.env.PATH}`, XDG_RUNTIME_DIR: "/run/user/1" },
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, lines: `${stdout}${stderr}`.trim().split("\n"), home }
}

async function withDeployDir(home: string): Promise<void> {
  await mkdir(join(home, "northline", "deploy"), { recursive: true })
}

describe("the bootstrap", () => {
  test("unpacks the release without a committed .env, installs it, and hands over to its runner", async () => {
    const run = await runBootstrap(withDeployDir)

    expect(run.exitCode).toBe(0)
    const release = join(run.home, "northline", "releases", "r2", "app")
    expect(await readFile(join(release, "package.json"), "utf8")).toBe("{}")
    expect(await Bun.file(join(release, ".env")).exists()).toBe(false)
    expect(run.lines).toContain(`runner node_modules/.bin/sixb-deploy-ssh release /plan.json`)
    // The upload is gone once it is a release.
    expect(await readdir(join(run.home, "northline", "deploy", "incoming"))).toEqual([])
  })

  test("reports each step, then its exit code last, for the laptop to follow", async () => {
    const run = await runBootstrap(withDeployDir)

    const events = run.lines.flatMap((line) => parseEvent(line) ?? [])
    expect(events).toEqual([
      { step: "Prepare release", status: "running" },
      { step: "Prepare release", status: "done" },
      { step: "Install Bun 1.4.2", status: "running" },
      { step: "Install Bun 1.4.2", status: "done" },
      { step: "Install dependencies", status: "running" },
      { step: "Install dependencies", status: "done" },
      { exit: 0 },
    ])
  })

  test("ends with the runner's exit code when the release fails", async () => {
    const run = await runBootstrap(withDeployDir, { runnerExit: 3 })

    expect(run.exitCode).toBe(3)
    expect(parseEvent(run.lines.at(-1) ?? "")).toEqual({ exit: 3 })
  })

  test("names a project that doesn't depend on @sixb/deploy-ssh", async () => {
    const run = await runBootstrap(withDeployDir, { withoutDeployBin: true })

    expect(run.exitCode).toBe(1)
    expect(run.lines).toContain(
      "@sixb/deploy-ssh is not installed. Add it to the project's dependencies."
    )
  })

  // Reproduce: drop the check on `current`; a redeploy that derives the same release id then
  // deletes the folder the live release runs from.
  test("refuses to unpack over the live release", async () => {
    const run = await runBootstrap(async (home) => {
      await withDeployDir(home)
      await mkdir(join(home, "northline", "releases", "r2", "app"), { recursive: true })
      await writeFile(join(home, "northline", "releases", "r2", "app", "package.json"), "live")
      await symlink("releases/r2", join(home, "northline", "current"))
    })

    expect(run.exitCode).toBe(1)
    expect(run.lines).toContain("Release r2 is the live one. Deploy again to make a new release.")
    expect(
      await readFile(join(run.home, "northline", "releases", "r2", "app", "package.json"), "utf8")
    ).toBe("live")
  })

  // Reproduce: drop the copy into shared/.env; the first slot deploy of a project without a
  // source then starts without its settings.
  test("keeps the .env a deployment from before releases kept in its code folder", async () => {
    const run = await runBootstrap(async (home) => {
      await withDeployDir(home)
      await mkdir(join(home, "northline", "code", "app"), { recursive: true })
      await writeFile(join(home, "northline", "code", "app", ".env"), "SECRET=1\n")
      await chmod(join(home, "northline", "code", "app", ".env"), 0o600)
    })

    expect(run.exitCode).toBe(0)
    expect(await readFile(join(run.home, "northline", "shared", ".env"), "utf8")).toBe("SECRET=1\n")
  })
})
