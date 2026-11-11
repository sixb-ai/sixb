import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { DeployScript } from "@sixb/core/deploy"
import { runDeployScript } from "../src/operations"
import { LocalShell } from "../src/transport"

const NAME = "northline"
const SERVER_CLI = resolve(import.meta.dir, "../src/server/cli.ts")

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * A deployment as `sixb deploy` leaves one, in a temporary home: its `ctl`, its manifest, and a
 * project whose `sixb` records how it was run instead of running anything.
 */
async function deployment(options: { readonly env?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "sixb-deploy-run-"))
  tempDirs.push(home)
  const root = join(home, NAME)
  const project = join(root, "code")
  const deployDir = join(root, "deploy")
  const log = join(home, "runs.jsonl")
  await mkdir(join(project, "node_modules", ".bin"), { recursive: true })
  await mkdir(deployDir, { recursive: true })

  await writeFile(
    join(project, "node_modules", ".bin", "sixb"),
    `const { appendFileSync, readFileSync } = require("node:fs")
const [, , command, path, ...args] = process.argv
appendFileSync(process.env.RUN_LOG, JSON.stringify({
  command, path, args, cwd: process.cwd(), nodeEnv: process.env.NODE_ENV,
  source: readFileSync(path, "utf8"),
}) + "\\n")
if (args[0] !== "wait") {
  process.exit(Number(readFileSync(process.env.RUN_DIR + "/exit-code", "utf8")))
}
for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
  process.on(signal, () => {
    appendFileSync(process.env.RUN_LOG, JSON.stringify({ got: signal }) + "\\n")
    process.exit(130)
  })
}
appendFileSync(process.env.RUN_LOG, JSON.stringify({ waiting: true }) + "\\n")
setInterval(() => {}, 1000)
`
  )
  const manifest = join(deployDir, "processes.json")
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      name: NAME,
      cwd: project,
      runDir: join(root, "run"),
      logDir: join(root, "run", "logs"),
      releasePath: join(deployDir, "release.json"),
      ...(options.env === false
        ? {}
        : { env: { NODE_ENV: "production", RUN_LOG: log, RUN_DIR: home } }),
      services: [],
    })
  )
  const ctl = join(deployDir, "ctl")
  await writeFile(
    ctl,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SERVER_CLI)} "$@" --manifest ${JSON.stringify(manifest)}\n`
  )
  await chmod(ctl, 0o755)

  // A server has util-linux's flock; a Mac does not, so it gets one that only takes the lock.
  const bin = join(home, "bin")
  await mkdir(bin)
  if (!Bun.which("flock")) {
    await writeFile(join(bin, "flock"), "#!/bin/sh\nexit 0\n")
    await chmod(join(bin, "flock"), 0o755)
  }
  const shell = new LocalShell({ HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` })

  return {
    project,
    deployDir,
    runDir: join(root, "run"),
    mark: (path: string) =>
      join(root, "run", "scripts", `${createHash("sha256").update(path).digest("hex")}.json`),
    run: async (script: Partial<DeployScript> & { readonly exit?: number } = {}) => {
      await writeFile(join(home, "exit-code"), String(script.exit ?? 0))
      return runDeployScript(shell, NAME, {
        path: "scripts/fix.ts",
        source: new TextEncoder().encode("export default async () => {}\n"),
        args: [],
        ...script,
      })
    },
    runs: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    uploads: () => readdir(join(deployDir, "runs")).catch(() => []),
  }
}

describe("runDeployScript", () => {
  test("runs an undeployed script from its path in the project, then removes it", async () => {
    const { project, run, runs, uploads } = await deployment()
    const source = 'export default async () => console.log("fixed")\n'

    const exitCode = await run({
      path: "scripts/once/fix.ts",
      source: new TextEncoder().encode(source),
      args: ["--dry-run", "it's", "--manifest", "x"],
      exit: 3,
    })

    expect(exitCode).toBe(3)
    expect(await runs()).toEqual([
      {
        command: "run",
        path: "scripts/once/fix.ts",
        args: ["--dry-run", "it's", "--manifest", "x"],
        cwd: await realpath(project),
        nodeEnv: "production",
        source,
      },
    ])
    // The file, the directories made for it, and the upload are gone.
    expect(await readdir(project)).toEqual(["node_modules"])
    expect(await uploads()).toEqual([])
  })

  test("runs the deployed script in place when it is the same file", async () => {
    const { project, run, runs } = await deployment()
    const source = "export default async () => {}\n"
    await mkdir(join(project, "scripts"))
    await writeFile(join(project, "scripts", "fix.ts"), source)

    expect(await run({ source: new TextEncoder().encode(source) })).toBe(0)

    expect(await runs()).toHaveLength(1)
    expect(await readFile(join(project, "scripts", "fix.ts"), "utf8")).toBe(source)
  })

  test("refuses to replace a deployed script that differs", async () => {
    const { project, run, runs, uploads } = await deployment()
    await mkdir(join(project, "scripts"))
    await writeFile(join(project, "scripts", "fix.ts"), "committed\n")

    expect(await run({ source: new TextEncoder().encode("mine\n") })).toBe(1)

    expect(await runs()).toEqual([])
    expect(await readFile(join(project, "scripts", "fix.ts"), "utf8")).toBe("committed\n")
    expect(await uploads()).toEqual([])
  })

  test("refuses a path that leaves the project, including through a symlink", async () => {
    const { project, run, runs } = await deployment()
    const outside = await mkdtemp(join(tmpdir(), "sixb-deploy-outside-"))
    tempDirs.push(outside)
    await symlink(outside, join(project, "linked"))

    expect(await run({ path: "../escape.ts" })).toBe(1)
    expect(await run({ path: "linked/deep/escape.ts" })).toBe(1)

    expect(await runs()).toEqual([])
    expect(await readdir(outside)).toEqual([])
  })

  // Guard proof: stop `ctl run` passing SIGHUP on, and the script never hears that the connection
  // dropped: it keeps running, holding the deploy lock, until this test's bound kills ctl.
  test("passes a hangup on to the script, which a dropped connection sends only to ctl", async () => {
    const { deployDir, project, runs } = await deployment()
    const staged = join(deployDir, "staged-upload")
    await writeFile(staged, "export default async () => {}\n")
    const ctl = Bun.spawn([join(deployDir, "ctl"), "run", staged, "scripts/wait.ts", "wait"], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    const bound = setTimeout(() => ctl.kill("SIGKILL"), 4_000)
    try {
      while (ctl.exitCode === null && !(await runs()).some((entry) => entry.waiting)) {
        await Bun.sleep(10)
      }
      ctl.kill("SIGHUP")

      expect(await ctl.exited).toBe(130)
      expect((await runs()).at(-1)).toEqual({ got: "SIGHUP" })
      expect(await readdir(project)).toEqual(["node_modules"])
    } finally {
      clearTimeout(bound)
    }
  })

  test("runs one script at a time per path", async () => {
    const { run, runs, mark } = await deployment()
    await writeMark(mark("scripts/fix.ts"), { pid: process.pid, path: "scripts/fix.ts" })

    expect(await run()).toBe(1)
    expect(await runs()).toEqual([])
  })

  // Guard proof: skip `removeAbandoned` in `runScript`, and the file a killed run wrote stays in the
  // deployed code; compare only `ino` there, and the replaced file below is deleted too.
  test("removes what a killed run wrote, unless something has replaced it since", async () => {
    const { project, run, runs, mark, runDir } = await deployment()
    await mkdir(join(project, "scripts"))
    const left = join(project, "scripts", "left.ts")
    await writeFile(left, "left behind\n")
    const written = await stat(left)
    // No process has this id: the run that wrote it is gone.
    await writeMark(mark("scripts/left.ts"), {
      pid: 2147483646,
      path: "scripts/left.ts",
      wrote: { ino: written.ino, mtimeMs: written.mtimeMs },
    })
    const deployed = join(project, "scripts", "deployed.ts")
    await writeFile(deployed, "deployed since\n")
    await writeMark(mark("scripts/deployed.ts"), {
      pid: 2147483646,
      path: "scripts/deployed.ts",
      wrote: { ino: (await stat(deployed)).ino, mtimeMs: 0 },
    })

    expect(await run()).toBe(0)

    expect(await runs()).toHaveLength(1)
    expect(await readdir(join(project, "scripts"))).toEqual(["deployed.ts"])
    expect(await readdir(join(runDir, "scripts"))).toEqual([])
  })

  // Guard proof: delete the two `flock -s` lines in `runDeployScript`, and the run finishes while
  // the deploy still holds the lock. Needs util-linux's flock, which servers and CI have.
  test.skipIf(!Bun.which("flock"))("waits while a deploy holds the lock", async () => {
    const { deployDir, run, runs } = await deployment()
    const deploy = Bun.spawn(["flock", "-x", join(deployDir, "lock"), "cat"], { stdin: "pipe" })
    try {
      // Held once `flock` runs `cat`.
      while (!(await processRunning("cat", deploy.pid))) await Bun.sleep(10)
      const running = run()
      while (!(await processRunning("flock -s -w 600 9"))) await Bun.sleep(10)
      expect(await runs()).toEqual([])

      deploy.stdin.end()
      expect(await running).toBe(0)
      expect(await runs()).toHaveLength(1)
    } finally {
      deploy.kill()
    }
  })

  test("refuses a deployment made before scripts could run, asking for a deploy", async () => {
    const { run, runs } = await deployment({ env: false })

    expect(await run()).toBe(1)
    expect(await runs()).toEqual([])
  })

  test("says plainly when nothing is deployed", async () => {
    const home = await mkdtemp(join(tmpdir(), "sixb-deploy-run-"))
    tempDirs.push(home)

    const error = await runDeployScript(new LocalShell({ HOME: home }), NAME, {
      path: "scripts/fix.ts",
      source: new Uint8Array(),
      args: [],
    }).catch((caught: unknown) => caught)

    expect(String(error)).toContain(`Nothing named ${NAME} is deployed on this server yet.`)
  })
})

async function writeMark(file: string, mark: Record<string, unknown>): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true })
  await writeFile(file, JSON.stringify(mark))
}

/** Whether a process whose command line contains `command` runs, as the child of `parent` if given. */
async function processRunning(command: string, parent?: number): Promise<boolean> {
  const ps = Bun.spawn(["ps", "-eo", "ppid=,args="], { stdout: "pipe" })
  const lines = (await new Response(ps.stdout).text()).split("\n")
  return lines.some((line) => {
    const [ppid, ...args] = line.trim().split(/\s+/)
    return args.join(" ").includes(command) && (parent === undefined || Number(ppid) === parent)
  })
}
