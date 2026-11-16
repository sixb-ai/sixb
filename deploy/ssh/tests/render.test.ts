import { describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DeployRelease } from "@sixb/core/deploy"
import { type DeploymentLayout, deploymentLayout, releaseLayout } from "../src/layout"
import {
  releaseForSlot,
  renderCaddySnippet,
  renderCtl,
  renderProcessManifest,
  renderUnit,
} from "../src/render"
import { type DeployScript, deriveReleaseId, renderDeployScript, STEP_MARKER } from "../src/scripts"

const release: DeployRelease = {
  name: "northline",
  target: { kind: "ssh", location: "sixb@203.0.113.10" },
  bunVersion: "1.4.2",
  env: { NODE_ENV: "production" },
  steps: {
    build: [{ program: "sixb", args: ["build"] }],
    beforeStart: [{ program: "sixb", args: ["db", "migrate"] }],
  },
  services: [
    {
      name: "api",
      kind: "http",
      command: { program: "sixb", args: ["api", "--host", "127.0.0.1", "--port", "3002"] },
      env: { NODE_ENV: "production", POSTGRES_POOL_MAX: "6" },
      instances: 1,
      http: {
        host: "127.0.0.1",
        port: 3002,
        domain: "api.example.com",
        publicOrigin: "https://api.example.com",
        readinessPath: "/ready",
      },
      process: { killTimeoutMs: 30_000, restartDelayMs: 1_000 },
    },
    {
      name: "app",
      kind: "http",
      command: { program: "sixb", args: ["app", "--host", "127.0.0.1", "--port", "3001"] },
      env: { NODE_ENV: "production" },
      instances: 1,
      http: {
        host: "127.0.0.1",
        port: 3001,
        domain: "example.com",
        publicOrigin: "https://example.com",
      },
      process: { killTimeoutMs: 10_000, restartDelayMs: 1_000 },
    },
    {
      name: "watcher",
      kind: "script",
      command: { program: "bun", args: ["scripts/watch.ts"] },
      env: { NODE_ENV: "production" },
      instances: 2,
      process: { killTimeoutMs: 10_000, restartDelayMs: 1_000, maxMemory: "256M" },
    },
  ],
}

const layout = deploymentLayout({
  home: "/home/sixb",
  user: "sixb",
  name: "northline",
  projectPath: "examples/northline",
  bunVersion: "1.4.2",
})

const deployScript = renderDeployScript({
  release,
  layout,
  incoming: "/home/sixb/northline/deploy/incoming/abc.123",
  record: {
    commit: "abc",
    ref: "main",
    deployedAt: "2026-09-30T12:00:00.000Z",
    deployedBy: "ci",
  },
})

describe("deployment files", () => {
  test("keep a deployment in its own directory, with immutable releases and Bun per user", () => {
    expect(layout.project).toBe("/home/sixb/northline/code/examples/northline")
    expect(layout.releasesDir).toBe("/home/sixb/northline/releases")
    expect(layout.currentLink).toBe("/home/sixb/northline/current")
    expect(layout.sharedEnv).toBe("/home/sixb/northline/shared/.env")
    expect(releaseLayout(layout, "r1").project).toBe(
      "/home/sixb/northline/releases/r1/examples/northline"
    )
    expect(layout.bun).toBe("/home/sixb/.sixb/bun/1.4.2/bun")
    expect(layout.unit).toBe("/home/sixb/.config/systemd/user/sixb-northline.service")
    expect(layout.caddySnippet).toBe("/etc/caddy/sixb.d/sixb/northline.caddy")
  })

  test("run Sixb services from their release directory and rewrite ports per slot", () => {
    const green = releaseForSlot(release, { app: 3011, api: 3012 })
    const targetRelease = releaseLayout(layout, "r1")
    const manifest = renderProcessManifest(green, layout, {
      projectDir: targetRelease.project,
      slot: "green",
    })

    expect(manifest.slot).toBe("green")
    expect(manifest.cwd).toBe(targetRelease.project)
    expect(manifest.services[0]).toMatchObject({
      kind: "http",
      processName: "northline-api",
      command: layout.bun,
      args: [
        `${targetRelease.project}/node_modules/.bin/sixb`,
        "api",
        "--host",
        "127.0.0.1",
        "--port",
        "3012",
      ],
      env: {
        NODE_ENV: "production",
        POSTGRES_POOL_MAX: "6",
        SIXB_DRAIN_TIMEOUT_MS: "290000",
      },
    })
    expect(manifest.services[1]?.args).toContain("3011")
    expect(manifest.services[2]).toMatchObject({
      kind: "script",
      command: layout.bun,
      args: ["scripts/watch.ts"],
      instances: 2,
      maxMemory: "256M",
    })
  })

  // Reproduce: give `serviceEnvWithDrain` a fixed 290000 again; a 15-minute kill timeout then
  // still drains for 290 seconds.
  test("drain a retiring API until just before the supervisor's SIGINT", () => {
    const api = release.services[0]
    if (!api) throw new Error("The fixture has an api service.")

    const longTurns: DeployRelease = {
      ...release,
      services: [{ ...api, process: { ...api.process, killTimeoutMs: 900_000 } }],
    }

    const [defaultApi] = renderProcessManifest(release, layout).services
    const [longApi] = renderProcessManifest(longTurns, layout).services

    expect(defaultApi?.env.SIXB_DRAIN_TIMEOUT_MS).toBe("290000")
    expect(longApi?.env.SIXB_DRAIN_TIMEOUT_MS).toBe("890000")
  })

  test("start the supervisor from a user unit that outlasts every kill timeout", () => {
    const unit = renderUnit(release, layout)

    expect(unit).toContain(`ExecStart=${layout.ctl} supervise`)
    expect(unit).toContain(
      "Environment=PATH=/home/sixb/.sixb/bun/1.4.2:/usr/local/bin:/usr/bin:/bin"
    )
    expect(unit).toContain("TimeoutStopSec=40")
    expect(unit).toContain("WantedBy=default.target")
    expect(renderCtl(layout)).toContain(
      `exec '/home/sixb/.sixb/bun/1.4.2/bun' '${layout.project}/node_modules/.bin/sixb-deploy-ssh' "$@" --manifest '${layout.manifest}'`
    )
  })

  test("route each domain with upstream dial retries, and the update page for the app only", () => {
    const snippet = renderCaddySnippet(release)

    expect(snippet).toContain("api.example.com {\n\tencode {")
    expect(snippet).toContain(
      [
        "example.com {",
        "\treverse_proxy 127.0.0.1:3001 {",
        "\t\tlb_try_duration 5s",
        "\t}",
        "\thandle_errors 502 503 504 {",
      ].join("\n")
    )
    expect(snippet.match(/handle_errors/g)?.length).toBe(1)
  })

  test("compress the API's JSON answers, and nothing the app serves", () => {
    const snippet = renderCaddySnippet(release)

    expect(snippet).toContain(
      [
        "api.example.com {",
        "\tencode {",
        "\t\tzstd",
        "\t\tgzip",
        "\t\tmatch {",
        "\t\t\tstatus 200",
        "\t\t\theader Content-Type application/json*",
        "\t\t}",
        "\t}",
        "\treverse_proxy 127.0.0.1:3002 {",
        "\t\tlb_try_duration 5s",
        "\t}",
        "}",
      ].join("\n")
    )
    expect(snippet.match(/\tencode /g)?.length).toBe(1)
  })
})

describe("deploy script", () => {
  test("validates as bash and runs migrations and readiness before switching routes", async () => {
    const child = Bun.spawn(["bash", "-n"], {
      stdin: new Blob([deployScript.script]),
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")

    expect(deployScript.labels).toEqual([
      "Prepare release",
      "Install Bun 1.4.2",
      "Install dependencies",
      "sixb build",
      "Check storage migrations",
      "sixb db migrate",
      "Start new release",
      "Check services",
      "Update routes",
      "Activate release",
    ])
  })

  describe("with a source for the project's values", () => {
    const { labels, script } = renderDeployScript({
      release: {
        ...release,
        steps: {
          ...release.steps,
          env: { program: "sixb", args: ["env", "pull", "--env", "prod"] },
        },
      },
      layout,
      incoming: "/home/sixb/northline/deploy/incoming/abc.123",
      record: {
        commit: "abc",
        ref: "main",
        deployedAt: "2026-09-30T12:00:00.000Z",
        deployedBy: "ci",
      },
    })

    test("pulls .env once dependencies are in, before the build and cutover", () => {
      const at = (label: string) => labels.indexOf(label)

      expect(at("sixb env pull --env prod")).toBe(at("Install dependencies") + 1)
      expect(at("sixb build")).toBeGreaterThan(at("sixb env pull --env prod"))
      expect(at("Start new release")).toBeGreaterThan(at("sixb env pull --env prod"))
    })

    test("gives only that step the path to its token", () => {
      const uses = script.split("\n").filter((line) => line.includes("env-token"))

      expect(uses).toHaveLength(1)
      expect(uses[0]).toEndWith(`'prod' --token-file '/home/sixb/northline/env-token'`)
    })

    // Reproduce: copy the pulled file into `shared/.env` and leave it in the release; the release
    // then holds its own copy again, and an edit to `shared/.env` never reaches it.
    test("makes the pulled .env the server's shared one, linked from the release", async () => {
      const step = stepBody("sixb env pull --env prod", { labels, script })
      const root = await mkdtemp(join(tmpdir(), "sixb-env-pull-"))
      try {
        const releaseProject = join(root, "release")
        const sharedEnv = join(root, "shared.env")
        await mkdir(releaseProject)
        await writeFile(sharedEnv, "API_KEY=old")
        await symlink(sharedEnv, join(releaseProject, ".env"))

        // Like `sixb env pull`, the stand-in writes a temporary file and renames it over `.env`.
        const pull = join(root, "pull")
        await writeFile(
          pull,
          [
            "#!/bin/sh",
            'printf "API_KEY=pulled" > "$RELEASE_PROJECT/.env.tmp"',
            'mv "$RELEASE_PROJECT/.env.tmp" "$RELEASE_PROJECT/.env"',
            "",
          ].join("\n"),
          { mode: 0o755 }
        )

        const child = Bun.spawn(["/bin/bash", "-euc", step], {
          env: {
            BUN: pull,
            RELEASE_PROJECT: releaseProject,
            SHARED_ENV: sharedEnv,
            PATH: "/usr/bin:/bin",
          },
          stderr: "pipe",
        })
        expect(await child.exited).toBe(0)

        expect(await readlink(join(releaseProject, ".env"))).toBe(sharedEnv)
        expect(await readFile(sharedEnv, "utf8")).toBe("API_KEY=pulled")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  test("runs no pull for a project that keeps its own .env", () => {
    expect(deployScript.labels.some((label) => label.includes("env pull"))).toBe(false)
  })

  test("holds the lock, keeps standard input closed, and prepares both blue and green routes", () => {
    const { script } = deployScript
    expect(script).toContain(`exec 9>'${layout.lock}'`)
    expect(script).toContain("flock -w 600 9")
    expect(script).toEndWith("main </dev/null\n")
    expect(script).toContain("export NODE_ENV='production'")
    expect(script).toContain("http://127.0.0.1:3002/ready")
    expect(script).toContain("http://127.0.0.1:3012/ready")
    expect(script).toContain("sudo -n /usr/bin/systemctl reload caddy")
  })

  test("carries one generation of hashed app chunks into the next release", async () => {
    const step = stepBody("sixb build")
    const root = await mkdtemp(join(tmpdir(), "sixb-carry-assets-"))
    try {
      const oldProject = join(root, "old")
      const newProject = join(root, "new")
      const thirdProject = join(root, "third")
      await mkdir(join(oldProject, ".sixb/dist/app"), { recursive: true })
      await writeFile(join(oldProject, ".sixb/dist/app/index.html"), "old-shell")
      await writeFile(join(oldProject, ".sixb/dist/app/chunk-r1-aaaa1111.js"), "r1-chunk")

      const buildInto = async (
        prev: string,
        next: string,
        chunkName: string,
        shellText: string
      ) => {
        await mkdir(join(next, "node_modules/.bin"), { recursive: true })
        await writeFile(
          join(next, "node_modules/.bin/sixb"),
          `import { mkdirSync, writeFileSync } from "node:fs"
mkdirSync(".sixb/dist/app", { recursive: true })
writeFileSync(".sixb/dist/app/index.html", ${JSON.stringify(shellText)})
writeFileSync(".sixb/dist/app/${chunkName}", ${JSON.stringify(chunkName)})
`
        )
        const child = Bun.spawn(["/bin/bash", "-euc", step], {
          env: {
            BUN: process.execPath,
            PROJECT: prev,
            RELEASE_PROJECT: next,
            PATH: "/usr/bin:/bin",
          },
        })
        expect(await child.exited).toBe(0)
      }

      await buildInto(oldProject, newProject, "chunk-r2-bbbb2222.js", "r2-shell")
      expect(await readFile(join(newProject, ".sixb/dist/app/index.html"), "utf8")).toBe("r2-shell")
      expect(await readFile(join(newProject, ".sixb/dist/app/chunk-r1-aaaa1111.js"), "utf8")).toBe(
        "r1-chunk"
      )

      // Release 3 carries r2's chunk, while r1's drops off after one generation.
      await buildInto(newProject, thirdProject, "chunk-r3-cccc3333.js", "r3-shell")
      expect(
        await readFile(join(thirdProject, ".sixb/dist/app/chunk-r2-bbbb2222.js"), "utf8")
      ).toBe("chunk-r2-bbbb2222.js")
      expect(
        await lstat(join(thirdProject, ".sixb/dist/app/chunk-r1-aaaa1111.js")).catch(() => null)
      ).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("lets dependency install scripts call node when the server has none", async () => {
    const step = stepBody("Install Bun 1.4.2")

    const root = await mkdtemp(join(tmpdir(), "sixb-install-bun-"))
    try {
      const runStep = async (name: string, withNode: boolean) => {
        const bunDir = join(root, name, "bun")
        const tools = join(root, name, "tools")
        await mkdir(bunDir, { recursive: true })
        await mkdir(tools, { recursive: true })
        await symlink(Bun.which("true")!, join(bunDir, "bun"))
        await symlink(Bun.which("ln")!, join(tools, "ln"))
        if (withNode) await writeFile(join(tools, "node"), "#!/bin/sh\n", { mode: 0o755 })
        const child = Bun.spawn(["/bin/bash", "-euc", step], {
          env: { BUN: join(bunDir, "bun"), BUN_DIR: bunDir, PATH: `${bunDir}:${tools}` },
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(await child.exited).toBe(0)
        return join(bunDir, "node")
      }

      const [linked, untouched] = await Promise.all([
        runStep("without-node", false),
        runStep("with-node", true),
      ])
      expect((await lstat(linked)).isSymbolicLink()).toBe(true)
      expect(await readlink(linked)).toBe(join(root, "without-node", "bun", "bun"))
      expect(await lstat(untouched).catch((error: unknown) => error)).toBeInstanceOf(Error)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("counts the quiet window after start from when the services started", async () => {
    const step = stepBody("Check services")
    const root = await mkdtemp(join(tmpdir(), "sixb-check-services-"))
    try {
      const tools = join(root, "tools")
      await mkdir(tools)
      await writeFile(join(tools, "sleep"), `#!/bin/sh\necho "$1" >> "$SLEPT"\n`, { mode: 0o755 })
      await writeFile(join(tools, "ctl"), "#!/bin/sh\necho checked\n", { mode: 0o755 })

      const check = async (name: string, bootSeconds: number) => {
        const slept = join(root, `${name}.txt`)
        await writeFile(slept, "")
        const child = Bun.spawn(
          [
            "/bin/bash",
            "-euc",
            `deploy_mode="cold"\ntarget_slot="blue"\nstarted=$((SECONDS - ${bootSeconds}))\n${step}`,
          ],
          {
            env: {
              BUN: Bun.which("true")!,
              CTL: join(tools, "ctl"),
              SLEPT: slept,
              PATH: `${tools}:/usr/bin:/bin`,
            },
            stdout: "pipe",
            stderr: "pipe",
          }
        )
        expect(await child.exited).toBe(0)
        expect(await new Response(child.stdout).text()).toBe("checked\n")
        return (await Bun.file(slept).text()).split("\n").filter(Boolean).map(Number)
      }

      const quick = await check("quick", 0)
      expect(quick).toHaveLength(1)
      expect(quick[0]).toBeGreaterThan(0)
      expect(quick[0]).toBeLessThanOrEqual(5)
      expect(await check("slow", 10)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * A test that runs deploy steps spawns bash and a few dozen short processes: under a second alone,
 * and past the default five seconds beside the whole suite.
 */
const STEP_RUN_TIMEOUT_MS = 20_000

describe("a release with storage migrations", () => {
  const migrationCheck = async (exitCode: number) => {
    const server = await standInServer({ bun: [`exit ${exitCode}`] })
    try {
      const result = await runDeploySteps(server, {
        before: `RELEASE_PROJECT=${server.root}`,
        steps: ["Check storage migrations"],
        after: 'echo "deploy_mode=$deploy_mode" >> "$CALLS"',
      })
      const calls = (await readFile(server.calls, "utf8")).trim().split("\n")
      return { exitCode: result.exitCode, calls }
    } finally {
      await server.remove()
    }
  }

  // Reproduce: drop the stop from "Check storage migrations"; the live release then keeps serving
  // while `sixb db migrate` drops columns it still writes.
  test(
    "stops the live release before migrating, so it never runs against the new schema",
    async () => {
      const { exitCode, calls } = await migrationCheck(3)

      expect(exitCode).toBe(0)
      expect(calls).toEqual([
        "bun sixb db",
        "systemctl --user is-active --quiet sixb-northline.service",
        "systemctl --user stop sixb-northline.service",
        "deploy_mode=stopped",
      ])
    },
    STEP_RUN_TIMEOUT_MS
  )

  // Redeploying an older commit with `--ref`: its `sixb` rejects `--check` as a usage error.
  // Reproduce: treat 2 as a failure; that rollback then can never deploy.
  test(
    "stops the live release too when the release cannot tell whether its schema changes",
    async () => {
      const { exitCode, calls } = await migrationCheck(2)

      expect(exitCode).toBe(0)
      expect(calls).toContain("systemctl --user stop sixb-northline.service")
      expect(calls).toContain("deploy_mode=stopped")
    },
    STEP_RUN_TIMEOUT_MS
  )

  test(
    "keeps the live release serving when the schema does not change",
    async () => {
      const { exitCode, calls } = await migrationCheck(0)

      expect(exitCode).toBe(0)
      expect(calls).toEqual(["bun sixb db", "deploy_mode=none"])
    },
    STEP_RUN_TIMEOUT_MS
  )

  test(
    "stops the deploy, and nothing else, when the schema cannot be read",
    async () => {
      const { exitCode, calls } = await migrationCheck(1)

      expect(exitCode).toBe(1)
      expect(calls).toEqual(["bun sixb db"])
    },
    STEP_RUN_TIMEOUT_MS
  )
})

describe("a deploy that fails", () => {
  // Reproduce: write `release.json` at the end of "Activate release" again; a check that fails
  // after the switch then leaves the record on the previous commit while the new one serves.
  test(
    "records the new release as soon as it takes over, even when a later check fails",
    async () => {
      const server = await standInServer({
        ctl: ['[ "$1" = activate ] && exit 0', "echo 'orchestrator exited' >&2", "exit 1"],
      })
      try {
        await writeFile(server.layout.candidateManifest, "{}")

        const result = await runDeploySteps(server, {
          before: 'deploy_mode="staged"',
          steps: ["Activate release"],
        })

        expect(result.exitCode).not.toBe(0)
        expect(await readlink(server.layout.currentLink)).toBe(`releases/${server.releaseId}`)
        expect(JSON.parse(await readFile(server.layout.releaseRecord, "utf8"))).toMatchObject({
          commit: "def456",
        })
        expect(result.stderr).toContain("The new release is in place")
      } finally {
        await server.remove()
      }
    },
    STEP_RUN_TIMEOUT_MS
  )

  // Reproduce: call `use_release` before the service files are installed; a failure there then
  // puts traffic back on the live release while `current` and `release.json` name the discarded one.
  test(
    "switches nothing when activation fails before the switch",
    async () => {
      const server = await standInServer({
        systemctl: ['[ "$2" = daemon-reload ] && exit 1', "exit 0"],
      })
      try {
        await writeFile(server.layout.candidateManifest, "{}")
        await writeFile(join(server.layout.deployDir, "Caddyfile.previous"), "live routes")
        await writeFile(server.caddySnippet, "candidate routes")

        const result = await runDeploySteps(server, {
          before: 'deploy_mode="routed"',
          steps: ["Activate release"],
        })

        expect(result.exitCode).not.toBe(0)
        expect(
          await lstat(server.layout.currentLink).catch((error: unknown) => error)
        ).toBeInstanceOf(Error)
        expect(await Bun.file(server.layout.releaseRecord).exists()).toBe(false)
        expect(await readFile(server.caddySnippet, "utf8")).toBe("live routes")
      } finally {
        await server.remove()
      }
    },
    STEP_RUN_TIMEOUT_MS
  )

  // Reproduce: let a failed reload leave the new routes in the snippet; the next deploy then
  // finds them unchanged, skips the reload, and retires the release Caddy still routes to.
  test(
    "puts the live routes back when Caddy does not reload",
    async () => {
      const server = await standInServer({ sudo: ["exit 1"] })
      try {
        await writeFile(server.caddySnippet, "live routes")

        const result = await runDeploySteps(server, {
          before: 'deploy_mode="staged"\ntarget_slot="green"',
          steps: ["Update routes"],
        })

        expect(result.exitCode).not.toBe(0)
        expect(await readFile(server.caddySnippet, "utf8")).toBe("live routes")
        expect(await readFile(server.calls, "utf8")).toContain("bun sixb-deploy-ssh discard")
      } finally {
        await server.remove()
      }
    },
    STEP_RUN_TIMEOUT_MS
  )

  // Reproduce: leave `deploy_mode` on "staged" after the reload; the trap then stops the
  // candidate while Caddy routes every request to it.
  test(
    "routes back to the live release before discarding a candidate Caddy already serves",
    async () => {
      const server = await standInServer()
      try {
        await writeFile(server.caddySnippet, "live routes")

        const result = await runDeploySteps(server, {
          before: 'deploy_mode="staged"\ntarget_slot="green"',
          steps: ["Update routes"],
          after: "false",
        })

        expect(result.exitCode).not.toBe(0)
        expect(await readFile(server.caddySnippet, "utf8")).toBe("live routes")
        expect((await readFile(server.calls, "utf8")).trim().split("\n")).toEqual([
          "sudo -n /usr/bin/systemctl reload caddy",
          "sudo -n /usr/bin/systemctl reload caddy",
          "bun sixb-deploy-ssh discard",
        ])
      } finally {
        await server.remove()
      }
    },
    STEP_RUN_TIMEOUT_MS
  )
})

interface StandInServer {
  readonly root: string
  readonly tools: string
  readonly layout: DeploymentLayout
  readonly releaseId: string
  readonly script: DeployScript
  /** Where the steps write the deployment's Caddy routes, in place of `/etc/caddy`. */
  readonly caddySnippet: string
  /** The `systemctl`, `sudo`, `ctl`, and `bun` calls the steps made, one per line. */
  readonly calls: string
  remove(): Promise<void>
}

/**
 * A deployment under a temporary home, with stand-ins for the server's tools: `systemctl`,
 * `sudo`, `ctl`, and `bun` record their calls, then run the given lines; `caddy`, `flock`, and
 * `sleep` return at once.
 */
async function standInServer(
  options: {
    readonly ctl?: readonly string[]
    readonly sudo?: readonly string[]
    readonly systemctl?: readonly string[]
    readonly bun?: readonly string[]
  } = {}
): Promise<StandInServer> {
  const root = await mkdtemp(join(tmpdir(), "sixb-deploy-steps-"))
  const tools = join(root, "tools")
  const calls = join(root, "calls.txt")
  const serverLayout = deploymentLayout({
    home: root,
    user: "sixb",
    name: "northline",
    projectPath: "examples/northline",
    bunVersion: "1.4.2",
  })
  const record = {
    commit: "def456",
    ref: "main",
    deployedAt: "2026-11-16T09:00:00.000Z",
    deployedBy: "ci",
  }

  const recorded = (name: string, then: readonly string[] = []) => [
    `echo "${name} $*" >> "$CALLS"`,
    ...then,
  ]
  const standIns: Record<string, readonly string[]> = {
    systemctl: recorded("systemctl", options.systemctl),
    sudo: recorded("sudo", options.sudo),
    ctl: recorded("ctl", options.ctl),
    bun: [`echo "bun $(basename "$1") $2" >> "$CALLS"`, ...(options.bun ?? [])],
    caddy: ["exit 0"],
    flock: ["exit 0"],
    sleep: ["exit 0"],
  }
  await mkdir(tools, { recursive: true })
  for (const [name, lines] of Object.entries(standIns)) {
    await writeFile(join(tools, name), ["#!/bin/sh", ...lines, ""].join("\n"), { mode: 0o755 })
  }
  await mkdir(serverLayout.deployDir, { recursive: true })
  await mkdir(join(root, "caddy"))
  await writeFile(calls, "")

  return {
    root,
    tools,
    layout: serverLayout,
    releaseId: deriveReleaseId(record),
    script: renderDeployScript({
      release,
      layout: serverLayout,
      incoming: join(serverLayout.incomingDir, "upload"),
      record,
    }),
    caddySnippet: join(root, "caddy", "northline.caddy"),
    calls,
    remove: () => rm(root, { recursive: true, force: true }),
  }
}

/**
 * Runs the deploy script's preamble (its variables, lock, functions and trap) with the stand-ins
 * in place, then `before` to set the state earlier steps would have left, the named steps, and
 * `after`.
 */
async function runDeploySteps(
  server: StandInServer,
  run: { readonly before: string; readonly steps: readonly string[]; readonly after?: string }
): Promise<{ readonly exitCode: number; readonly stderr: string }> {
  const preamble = server.script.script
    .split("main() {\n")[1]
    ?.split(`printf '\\n%s\\t%s\\t%s\\n' ${STEP_MARKER} 0 start`)[0]
  if (!preamble) throw new Error("Missing the deploy script's preamble")

  const body = [
    "set -euo pipefail",
    preamble,
    `BUN=${join(server.tools, "bun")}`,
    `CTL=${join(server.tools, "ctl")}`,
    `CADDY_DIR=${join(server.root, "caddy")}`,
    `CADDY_SNIPPET=${server.caddySnippet}`,
    run.before,
    ...run.steps.map((label) => stepBody(label, server.script)),
    run.after ?? "",
  ].join("\n")

  const child = Bun.spawn(["/bin/bash", "-c", body], {
    env: {
      CALLS: server.calls,
      PATH: `${server.tools}:/usr/bin:/bin`,
      XDG_RUNTIME_DIR: server.root,
    },
    stdout: "ignore",
    stderr: "pipe",
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { exitCode, stderr }
}

function stepBody(label: string, rendered = deployScript): string {
  const index = rendered.labels.indexOf(label)
  const body = rendered.script
    .split(`${STEP_MARKER} ${index} start\n`)[1]
    ?.split(`\nprintf '%s\\t%s\\t%s\\n' ${STEP_MARKER} ${index} done`)[0]
  if (!body) throw new Error(`Missing ${label} step`)
  return body
}
