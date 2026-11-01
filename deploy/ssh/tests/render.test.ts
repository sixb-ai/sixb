import { describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DeployRelease } from "@sixb/core/deploy"
import { deploymentLayout } from "../src/layout"
import { renderCaddySnippet, renderCtl, renderProcessManifest, renderUnit } from "../src/render"
import { renderDeployScript, STEP_MARKER } from "../src/scripts"

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
  test("keep a deployment in its own directory, and Bun per user and version", () => {
    expect(layout.project).toBe("/home/sixb/northline/code/examples/northline")
    expect(layout.bun).toBe("/home/sixb/.sixb/bun/1.4.2/bun")
    expect(layout.unit).toBe("/home/sixb/.config/systemd/user/sixb-northline.service")
    expect(layout.caddySnippet).toBe("/etc/caddy/sixb.d/sixb/northline.caddy")
  })

  test("run Sixb services with the project's CLI and scripts with its Bun", () => {
    const manifest = renderProcessManifest(release, layout)

    expect(manifest.cwd).toBe(layout.project)
    expect(manifest.services[0]).toMatchObject({
      processName: "northline-api",
      command: layout.bun,
      args: [
        `${layout.project}/node_modules/.bin/sixb`,
        "api",
        "--host",
        "127.0.0.1",
        "--port",
        "3002",
      ],
      env: { NODE_ENV: "production", POSTGRES_POOL_MAX: "6" },
    })
    expect(manifest.services[2]).toMatchObject({
      command: layout.bun,
      args: ["scripts/watch.ts"],
      instances: 2,
      maxMemory: "256M",
    })
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

  test("route each domain, with the update page for the app only", () => {
    const snippet = renderCaddySnippet(release)

    expect(snippet).toContain("api.example.com {\n\tencode {")
    expect(snippet).toContain(
      "\n\nexample.com {\n\treverse_proxy 127.0.0.1:3001\n\thandle_errors 502 503 504 {"
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
        "\treverse_proxy 127.0.0.1:3002",
        "}",
      ].join("\n")
    )
    expect(snippet.match(/\tencode /g)?.length).toBe(1)
  })
})

describe("deploy script", () => {
  test("names every step, in order, around the release's own commands", () => {
    expect(deployScript.labels).toEqual([
      "Apply files",
      "Install Bun 1.4.2",
      "Install dependencies",
      "sixb build",
      "Write services",
      "Update routes",
      "Stop services",
      "sixb db migrate",
      "Start services",
      "Check services",
      "Record release",
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

    // The services are still up here, so a pull that fails leaves the running release alone.
    test("pulls .env once dependencies are in, before the build and any stop", () => {
      const at = (label: string) => labels.indexOf(label)

      expect(at("sixb env pull --env prod")).toBe(at("Install dependencies") + 1)
      expect(at("sixb build")).toBeGreaterThan(at("sixb env pull --env prod"))
      expect(at("Stop services")).toBeGreaterThan(at("sixb env pull --env prod"))
    })

    test("gives only that step the path to its token", () => {
      const uses = script.split("\n").filter((line) => line.includes("env-token"))

      expect(uses).toHaveLength(1)
      expect(uses[0]).toEndWith(`'prod' --token-file '/home/sixb/northline/env-token'`)
    })
  })

  test("runs no pull for a project that keeps its own .env", () => {
    expect(deployScript.labels.some((label) => label.includes("env pull"))).toBe(false)
  })

  test("holds the lock, keeps standard input closed, and waits for the API", () => {
    const { script } = deployScript
    expect(script).toContain(`exec 9>'${layout.lock}'`)
    expect(script).toContain("flock -w 600 9")
    expect(script).toEndWith("main </dev/null\n")
    expect(script).toContain("export NODE_ENV='production'")
    expect(script).toContain("ready_url='http://127.0.0.1:3002/ready'")
    expect(script).toContain("sudo -n /usr/bin/systemctl reload caddy")
  })

  test("lets dependency install scripts call node when the server has none", async () => {
    // Red check: remove the node link from renderInstallBun; the first case finds no link.
    const step = stepBody("Install Bun 1.4.2")

    const root = await mkdtemp(join(tmpdir(), "sixb-install-bun-"))
    try {
      const runStep = async (name: string, withNode: boolean) => {
        const bunDir = join(root, name, "bun")
        const tools = join(root, name, "tools")
        await mkdir(bunDir, { recursive: true })
        await mkdir(tools, { recursive: true })
        // Bun is already installed, so the step skips the download. A link to an existing program
        // stands in for it: macOS vets a freshly written executable for ~150ms on its first run.
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
    // Red check: put back a fixed `sleep 5` after the readiness wait; the slow boot then sleeps.
    const step = stepBody("Check services")
    const root = await mkdtemp(join(tmpdir(), "sixb-check-services-"))
    try {
      const tools = join(root, "tools")
      await mkdir(tools)
      // `sleep` records how long it was asked to wait instead of waiting.
      await writeFile(join(tools, "sleep"), `#!/bin/sh\necho "$1" >> "$SLEPT"\n`, { mode: 0o755 })
      await writeFile(join(tools, "ctl"), "#!/bin/sh\necho checked\n", { mode: 0o755 })

      // The API answers at once, after the services have been up for `bootSeconds`.
      const check = async (name: string, bootSeconds: number) => {
        const slept = join(root, `${name}.txt`)
        await writeFile(slept, "")
        const child = Bun.spawn(
          ["/bin/bash", "-euc", `started=$((SECONDS - ${bootSeconds}))\n${step}`],
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

function stepBody(label: string): string {
  const index = deployScript.labels.indexOf(label)
  const body = deployScript.script
    .split(`${STEP_MARKER} ${index} start\n`)[1]
    ?.split(`\nprintf '%s\\t%s\\t%s\\n' ${STEP_MARKER} ${index} done`)[0]
  if (!body) throw new Error(`Missing ${label} step`)
  return body
}
