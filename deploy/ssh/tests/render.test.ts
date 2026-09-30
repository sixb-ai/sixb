import { describe, expect, test } from "bun:test"
import type { DeployRelease } from "@sixb/core/deploy"
import { deploymentLayout } from "../src/layout"
import { renderCaddySnippet, renderCtl, renderProcessManifest, renderUnit } from "../src/render"
import { renderDeployScript } from "../src/scripts"

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

  test("route each domain, with the update page for the app and Atlas only", () => {
    const snippet = renderCaddySnippet(release)

    expect(snippet).toContain("api.example.com {\n\treverse_proxy 127.0.0.1:3002\n}")
    expect(snippet).toContain(
      "example.com {\n\treverse_proxy 127.0.0.1:3001\n\thandle_errors 502 503 504 {"
    )
    expect(snippet.match(/handle_errors/g)?.length).toBe(1)
  })
})

describe("deploy script", () => {
  test("names every step, in order, around the release's own commands", () => {
    const { labels } = renderDeployScript({
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

    expect(labels).toEqual([
      "Apply files",
      "Install Bun 1.4.2",
      "Install dependencies",
      "sixb build",
      "Stop services",
      "sixb db migrate",
      "Write services",
      "Update routes",
      "Start services",
      "Check services",
      "Record release",
    ])
  })

  test("holds the lock, keeps standard input closed, and waits for the API", () => {
    const { script } = renderDeployScript({
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

    expect(script).toContain(`exec 9>'${layout.lock}'`)
    expect(script).toContain("flock -w 600 9")
    expect(script).toEndWith("main </dev/null\n")
    expect(script).toContain("export NODE_ENV='production'")
    expect(script).toContain("ready_url='http://127.0.0.1:3002/ready'")
    expect(script).toContain("sudo -n /usr/bin/systemctl reload caddy")
  })
})
