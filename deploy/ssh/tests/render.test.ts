import { describe, expect, test } from "bun:test"
import type { DeployRelease } from "@sixb/core/deploy"
import { deploymentLayout, releaseLayout, SLOT_PORTS, slotLayout } from "../src/layout"
import {
  releaseForSlot,
  renderCaddySnippet,
  renderCtl,
  renderLauncher,
  renderProcessManifest,
  renderSlotUnit,
} from "../src/render"
import { release } from "./fixtures/release"

const layout = deploymentLayout({ home: "/home/deploy", user: "deploy", name: "northline" })
const green = slotLayout(layout, "green")
const next = releaseLayout(layout, {
  id: "r1",
  projectPath: "examples/northline",
  bunVersion: "1.4.2",
})

function manifestFor(candidate: DeployRelease, holdExclusive = false) {
  return renderProcessManifest(releaseForSlot(candidate, SLOT_PORTS.green), {
    layout,
    slot: green,
    release: next,
    holdExclusive,
  })
}

describe("deployment files", () => {
  test("keep a deployment in one folder, each slot's state in its own, and Bun per version", () => {
    expect(next.project).toBe("/home/deploy/northline/releases/r1/examples/northline")
    expect(next.bun).toBe("/home/deploy/.sixb/bun/1.4.2/bun")
    expect(layout.currentLink).toBe("/home/deploy/northline/current")
    expect(layout.sharedEnv).toBe("/home/deploy/northline/shared/.env")
    expect(layout.unitTemplate).toBe("/home/deploy/.config/systemd/user/sixb-northline@.service")
    expect(layout.caddySnippet).toBe("/etc/caddy/sixb.d/deploy/northline.caddy")
    expect(green).toEqual({
      slot: "green",
      unit: "sixb-northline@green.service",
      manifest: "/home/deploy/northline/deploy/green.json",
      launcher: "/home/deploy/northline/deploy/green",
      runDir: "/home/deploy/northline/run/green",
      logDir: "/home/deploy/northline/run/green/logs",
    })
  })

  test("run Sixb services from their release folder, on their slot's ports", () => {
    const manifest = manifestFor(release)

    expect(manifest).toMatchObject({ slot: "green", cwd: next.project, runDir: green.runDir })
    expect(manifest.holdExclusive).toBeUndefined()
    expect(manifest.services[0]).toMatchObject({
      kind: "http",
      processName: "northline-api",
      command: next.bun,
      args: [
        `${next.project}/node_modules/.bin/sixb`,
        "api",
        "--host",
        "127.0.0.1",
        "--port",
        "3012",
      ],
      env: { NODE_ENV: "production", POSTGRES_POOL_MAX: "6", SIXB_DRAIN_TIMEOUT_MS: "290000" },
    })
    expect(manifest.services[1]?.args).toContain("3011")
    expect(manifest.services.at(-1)).toMatchObject({
      kind: "script",
      command: next.bun,
      args: ["scripts/watch.ts"],
      instances: 2,
      maxMemory: "256M",
    })
    expect(manifestFor(release, true).holdExclusive).toBe(true)
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

    expect(manifestFor(release).services[0]?.env.SIXB_DRAIN_TIMEOUT_MS).toBe("290000")
    expect(manifestFor(longTurns).services[0]?.env.SIXB_DRAIN_TIMEOUT_MS).toBe("890000")
  })

  test("start each slot's supervisor from a template unit that outlasts its drain", () => {
    const unit = renderSlotUnit(release, layout)

    expect(unit).toContain("Description=Sixb deployment northline, %i slot")
    expect(unit).toContain("ExecStart=/home/deploy/northline/deploy/%i")
    expect(unit).toContain("KillMode=mixed")
    expect(unit).toContain("TimeoutStopSec=315")
    expect(unit).toContain("WantedBy=default.target")
  })

  test("run the release's own server half, with its Bun first on PATH", () => {
    expect(renderLauncher(next, green)).toContain(
      `exec '/home/deploy/.sixb/bun/1.4.2/bun' '${next.project}/node_modules/.bin/sixb-deploy-ssh' 'supervise' --manifest '${green.manifest}'`
    )
    expect(renderCtl(next, green)).toContain(
      `exec '/home/deploy/.sixb/bun/1.4.2/bun' '${next.project}/node_modules/.bin/sixb-deploy-ssh' "$@" --manifest '${green.manifest}'`
    )
    expect(renderCtl(next, green)).toContain("PATH='/home/deploy/.sixb/bun/1.4.2':\"$PATH\"")
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
        "\t\tstream_close_delay 300s",
        "\t}",
        "}",
      ].join("\n")
    )
    expect(snippet.match(/\tencode /g)?.length).toBe(1)
  })

  // Reproduce: leave `stream_close_delay` out of the API's site; Caddy's reload then closes every
  // open WebSocket with 1001 before the retiring API can send 1012, and each page shows a drop.
  test("keep the API's WebSockets on the retiring release through Caddy's reload", () => {
    const api = release.services[0]
    if (!api) throw new Error("The fixture has an api service.")
    const longTurns: DeployRelease = {
      ...release,
      services: [{ ...api, process: { ...api.process, killTimeoutMs: 900_000 } }],
    }

    expect(renderCaddySnippet(release)).toContain("\t\tstream_close_delay 300s\n")
    expect(renderCaddySnippet(release).match(/stream_close_delay/g)?.length).toBe(1)
    expect(renderCaddySnippet(longTurns)).toContain("\t\tstream_close_delay 900s\n")
  })
})
