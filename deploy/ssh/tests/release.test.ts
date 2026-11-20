import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type DeploySlot,
  deploymentLayout,
  legacyLayout,
  releaseLayout,
  SLOT_PORTS,
  slotLayout,
} from "../src/layout"
import { parseEvent, type ReleasePlan } from "../src/plan"
import { releaseForSlot, renderProcessManifest } from "../src/render"
import { isExclusiveService, loadProcessManifest } from "../src/server/manifest"
import { carryAssets, type ReleaseHost, runRelease } from "../src/server/release"
import type { ProcessState } from "../src/server/state"
import { release } from "./fixtures/release"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sixb-release-"))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const PROJECT = "examples/northline"

function plan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    version: 1,
    release,
    record: { commit: "c2", ref: "main", deployedAt: "2026-11-20T12:00:00.000Z", deployedBy: "ci" },
    releaseId: "r2",
    projectPath: PROJECT,
    ...overrides,
  }
}

/**
 * systemd, Caddy and the supervisors, as the rollout sees them. A started slot's processes run
 * from its manifest; `crashes` names services that exit as soon as they start.
 */
class FakeServer implements ReleaseHost {
  readonly calls: string[] = []
  readonly printed: string[] = []
  readonly active = new Set<string>()
  readonly states = new Map<string, ProcessState>()
  readonly crashes = new Set<string>()
  /** Calls that throw, as `calls` records them. */
  readonly refuses = new Set<string>()
  /** Units that keep running after `stop --no-block`, as a draining service does. */
  readonly drains = new Set<string>()
  routes: string | null = null
  ready = true
  caddyAccepts = true
  /** Whether `sixb db migrate --check` finds migrations pending. */
  pendingMigrations = false

  async run(command: readonly string[]) {
    const words = command.map((word) =>
      word.replace(/.*\/node_modules\/\.bin\//, "").replace(/.*\/\.sixb\/bun\/[^/]+\/bun$/, "bun")
    )
    this.calls.push(words.join(" "))
    const line = words.join(" ")
    if (line.endsWith("db migrate --check")) return this.pendingMigrations ? 3 : 0
    return 0
  }

  async systemctl(...args: string[]) {
    const call = `systemctl ${args.join(" ")}`
    this.calls.push(call)
    if (this.refuses.has(call)) throw new Error(`refused: ${call}`)
    const unit = args.at(-1) ?? ""
    if (args[0] === "start") {
      this.active.add(unit)
      await this.startSlot(unit)
    }
    if (args[0] === "stop" && !(args[1] === "--no-block" && this.drains.has(unit))) {
      this.active.delete(unit)
    }
    return 0
  }

  async isActive(unit: string) {
    return this.active.has(unit)
  }

  async readRoutes() {
    return this.routes
  }

  async writeRoutes(_path: string, routes: string | null) {
    this.routes = routes
  }

  async validateCaddy() {
    return this.caddyAccepts ? null : "Error: adapting config"
  }

  async reloadCaddy() {
    this.calls.push(`reload caddy -> ${this.routedPort()}`)
    return true
  }

  async answers(url: string) {
    this.calls.push(`ready ${url}`)
    return this.ready
  }

  async supervise(runDir: string, command: string, service: string) {
    const call = `${runDir.split("/").at(-1)} ${command} ${service}`
    this.calls.push(call)
    if (this.refuses.has(call)) throw new Error(`refused: ${call}`)
    const state = this.states.get(runDir)
    if (!state) throw new Error("not running")
    this.states.set(runDir, {
      ...state,
      instances: state.instances.map((instance) =>
        instance.service !== service
          ? instance
          : command === "stop"
            ? { ...instance, status: "stopped" }
            : this.crashes.has(service)
              ? { ...instance, status: "exited", restarts: 1 }
              : { ...instance, status: "running" }
      ),
    })
  }

  async readState(runDir: string) {
    return this.states.get(runDir) ?? null
  }

  async sleep() {}

  print(line: string) {
    this.printed.push(line)
  }

  steps() {
    return this.printed.flatMap((line) => {
      const event = parseEvent(line)
      return event && "step" in event && event.status === "done" ? [event.step] : []
    })
  }

  /** Where Caddy sends the app's domain. */
  routedPort() {
    return (
      this.routes?.match(/^example\.com \{\n\treverse_proxy 127\.0\.0\.1:(\d+)/m)?.[1] ?? "none"
    )
  }

  private async startSlot(unit: string) {
    const slot = unit.match(/@(blue|green)\.service$/)?.[1] as DeploySlot | undefined
    if (!slot) return
    const layout = deploymentLayout({ home, user: "deploy", name: "northline" })
    const manifest = await loadProcessManifest(slotLayout(layout, slot).manifest)
    this.states.set(slotLayout(layout, slot).runDir, {
      version: 1,
      name: "northline",
      supervisorPid: process.pid,
      updatedAt: "2026-11-20T12:00:00.000Z",
      instances: manifest.services.flatMap((service) =>
        Array.from({ length: service.instances }, (_, instance) => {
          const held = manifest.holdExclusive && isExclusiveService(service)
          const crashed = !held && this.crashes.has(service.name)
          return {
            service: service.name,
            processName: service.processName,
            instance,
            status: held
              ? ("stopped" as const)
              : crashed
                ? ("exited" as const)
                : ("running" as const),
            restarts: crashed ? 1 : 0,
            logPath: "",
          }
        })
      ),
    })
  }
}

/** A server whose `blue` slot serves release `r1`, as an earlier slot deploy left it. */
async function liveInBlue(server: FakeServer): Promise<void> {
  const layout = deploymentLayout({ home, user: "deploy", name: "northline" })
  const blue = slotLayout(layout, "blue")
  const r1 = releaseLayout(layout, { id: "r1", projectPath: PROJECT, bunVersion: "1.4.2" })
  await mkdir(r1.project, { recursive: true })
  // What the bootstrap unpacked for this deploy.
  await mkdir(join(layout.releasesDir, "r2", PROJECT), { recursive: true })
  await mkdir(layout.deployDir, { recursive: true })
  await symlink("releases/r1", layout.currentLink)
  await symlink("current", layout.code)
  await writeFile(layout.liveSlotFile, "blue\n")
  const manifest = renderProcessManifest(releaseForSlot(release, SLOT_PORTS.blue), {
    layout,
    slot: blue,
    release: r1,
    holdExclusive: false,
  })
  await writeFile(blue.manifest, JSON.stringify(manifest))
  server.active.add(blue.unit)
  server.routes = "example.com {\n\treverse_proxy 127.0.0.1:3001 {"
  await server.systemctl("start", blue.unit)
  server.calls.length = 0
}

/** A server whose one service from before slots serves from `code/`, on the green ports. */
async function legacyInGreen(server: FakeServer): Promise<void> {
  const layout = deploymentLayout({ home, user: "deploy", name: "northline" })
  const legacy = legacyLayout(layout)
  await mkdir(join(layout.code, PROJECT), { recursive: true })
  await writeFile(join(layout.code, PROJECT, "package.json"), "{}")
  await mkdir(join(layout.releasesDir, "r2", PROJECT), { recursive: true })
  await mkdir(layout.deployDir, { recursive: true })
  await mkdir(layout.unitDir, { recursive: true })
  await writeFile(legacy.unitPath, "[Service]\n")
  await writeFile(join(layout.deployDir, "ports.txt"), "3011\n")
  await writeFile(
    legacy.manifest,
    JSON.stringify({
      ...renderProcessManifest(releaseForSlot(release, SLOT_PORTS.green), {
        layout,
        slot: slotLayout(layout, "green"),
        release: releaseLayout(layout, { id: "x", projectPath: PROJECT, bunVersion: "1.4.2" }),
        holdExclusive: false,
      }),
      slot: "green",
    })
  )
  server.active.add(legacy.unit)
  server.routes = "example.com {\n\treverse_proxy 127.0.0.1:3011 {"
}

/** Releases a later deploy drained and the next one prunes. */
async function oldReleases(...ids: string[]): Promise<void> {
  for (const id of ids) await mkdir(join(home, "northline", "releases", id), { recursive: true })
}

describe("a first deploy", () => {
  test("starts the blue slot with everything, routes to it, and records it", async () => {
    const server = new FakeServer()
    await mkdir(join(home, "northline", "releases", "r2", PROJECT), { recursive: true })

    await runRelease(plan(), server, { home, user: "deploy" })

    const layout = deploymentLayout({ home, user: "deploy", name: "northline" })
    // Nothing is live, so nothing needs to stop while the schema migrates.
    expect(server.calls[1]).toBe("bun sixb check --migrate --lake")
    expect(server.calls).toContain("systemctl start sixb-northline@blue.service")
    expect(server.calls).toContain("ready http://127.0.0.1:3002/ready")
    expect(server.routedPort()).toBe("3001")
    expect(await readlink(layout.currentLink)).toBe("releases/r2")
    expect(await readFile(layout.liveSlotFile, "utf8")).toBe("blue\n")
    expect(await readFile(layout.releaseRecord, "utf8")).toContain('"commit":"c2"')
    expect(await readFile(layout.ctl, "utf8")).toContain("--manifest '")
    expect(server.calls).toContain("systemctl enable sixb-northline@blue.service")
    expect((await loadProcessManifest(slotLayout(layout, "blue").manifest)).holdExclusive).toBe(
      undefined
    )
    expect(server.steps()).toEqual([
      "sixb build",
      "sixb check --migrate --lake",
      "Start new release",
      "Check services",
      "Update routes",
      "Move singletons",
      "Retire previous release",
    ])
  })
})

describe("a deploy beside the live release", () => {
  test("starts green beside blue, moves the routes and singletons, then lets blue drain", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    await oldReleases("r0")

    await runRelease(plan(), server, { home, user: "deploy" })

    expect(server.calls).toEqual([
      "bun sixb build",
      "bun sixb db migrate --check",
      "bun sixb check --migrate --lake",
      "systemctl daemon-reload",
      "systemctl start sixb-northline@green.service",
      "ready http://127.0.0.1:3012/ready",
      "reload caddy -> 3011",
      "blue stop orchestrator",
      "blue stop watcher",
      "green start orchestrator",
      "green start watcher",
      "systemctl enable sixb-northline@green.service",
      "systemctl disable sixb-northline@blue.service",
      "systemctl stop --no-block sixb-northline@blue.service",
    ])
    // The previous release drains, and a rollback may need it; older ones go.
    expect((await readdir(join(home, "northline", "releases"))).sort()).toEqual(["r1", "r2"])
  })

  // Reproduce: start green without `holdExclusive`; it then runs a second orchestrator beside
  // blue's until the routes move.
  test("keeps green's singletons stopped until the routes have moved", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    const green = slotLayout(deploymentLayout({ home, user: "deploy", name: "northline" }), "green")
    let heldAtRouting: string[] = []
    const reload = server.reloadCaddy.bind(server)
    server.reloadCaddy = async () => {
      heldAtRouting = (await server.readState(green.runDir))!.instances
        .filter((instance) => instance.status === "stopped")
        .map((instance) => instance.service)
      return reload()
    }

    await runRelease(plan(), server, { home, user: "deploy" })

    expect(heldAtRouting).toEqual(["orchestrator", "watcher", "watcher"])
  })

  test("a new API that never answers leaves blue serving and stops green", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    server.ready = false

    const error = await runRelease(plan(), server, { home, user: "deploy" }).catch(
      (failure: unknown) => failure
    )

    expect(String(error)).toContain("The API did not answer http://127.0.0.1:3012/ready")
    expect(String(error)).toContain("The previous release is still serving.")
    expect(server.routedPort()).toBe("3001")
    expect(server.active).toEqual(new Set(["sixb-northline@blue.service"]))
    expect(server.calls).not.toContain("blue stop orchestrator")
    expect(await readlink(join(home, "northline", "current"))).toBe("releases/r1")
  })

  test("a process that exits as it starts fails the check before any traffic moves", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    server.crashes.add("app")

    const error = await runRelease(plan(), server, { home, user: "deploy" }).catch(
      (failure: unknown) => failure
    )

    expect(String(error)).toContain("app did not stay up")
    expect(server.routedPort()).toBe("3001")
    expect(server.active.has("sixb-northline@green.service")).toBe(false)
  })

  test("routes Caddy rejects are put back, and green stops", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    server.caddyAccepts = false

    const error = await runRelease(plan(), server, { home, user: "deploy" }).catch(
      (failure: unknown) => failure
    )

    expect(String(error)).toContain("Caddy rejected the routes")
    expect(server.routes).toBe("example.com {\n\treverse_proxy 127.0.0.1:3001 {")
    expect(server.active.has("sixb-northline@green.service")).toBe(false)
  })

  // Reproduce: leave out the undo that stops green's singletons, or push it before blue's; blue's
  // orchestrator then starts while green's still runs.
  test("a singleton that fails after the switch rolls everything back to blue", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    server.crashes.add("orchestrator")

    const error = await runRelease(plan(), server, { home, user: "deploy" }).catch(
      (failure: unknown) => failure
    )

    expect(String(error)).toContain("orchestrator did not stay up")
    expect(String(error)).toContain("The previous release is still serving.")
    expect(server.routedPort()).toBe("3001")
    // Undone in reverse: green's singletons stop before blue's start, then the routes, then green.
    expect(server.calls.slice(-6)).toEqual([
      "green stop orchestrator",
      "green stop watcher",
      "blue start orchestrator",
      "blue start watcher",
      "reload caddy -> 3001",
      "systemctl stop sixb-northline@green.service",
    ])
    expect(await readFile(join(home, "northline", "deploy", "live-slot"), "utf8")).toBe("blue\n")
  })

  // Reproduce: push the undo that starts blue's singletons after the loop that stops them; the
  // orchestrator blue stopped before the failure then stays stopped.
  test("a singleton blue fails to stop is undone with the ones it did stop", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    server.refuses.add("blue stop watcher")

    const error = await runRelease(plan(), server, { home, user: "deploy" }).catch(
      (failure: unknown) => failure
    )

    expect(String(error)).toContain("refused: blue stop watcher")
    expect(server.calls.slice(server.calls.indexOf("blue stop watcher"))).toEqual([
      "blue stop watcher",
      "blue start orchestrator",
      "blue start watcher",
      "reload caddy -> 3001",
      "systemctl stop sixb-northline@green.service",
    ])
  })

  // Reproduce: write `live-slot` in retire instead of after the routes move; it still names blue
  // while green serves, and a deploy that dies there makes the next one stop green.
  test("names green live as soon as the routes move", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    const layout = deploymentLayout({ home, user: "deploy", name: "northline" })
    let recordedAtSwitch = ""
    const supervise = server.supervise.bind(server)
    server.supervise = async (runDir, command, service) => {
      if (command === "stop" && !recordedAtSwitch) {
        recordedAtSwitch = await readFile(layout.liveSlotFile, "utf8")
      }
      return supervise(runDir, command, service)
    }

    await runRelease(plan(), server, { home, user: "deploy" })

    expect(recordedAtSwitch).toBe("green\n")
  })

  test("a failure while retiring blue says green serves", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    server.refuses.add("systemctl enable sixb-northline@green.service")

    const error = await runRelease(plan(), server, { home, user: "deploy" }).catch(
      (failure: unknown) => failure
    )

    expect(String(error)).toContain("The new release is serving; cleaning up after the previous")
    expect(server.routedPort()).toBe("3011")
    expect(await readFile(join(home, "northline", "deploy", "live-slot"), "utf8")).toBe("green\n")
  })
})

describe("a release with storage migrations", () => {
  // Reproduce: run the migrations with blue serving; blue then runs against a schema it was
  // never built for.
  test("stops blue while they run, then starts green cold", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    server.pendingMigrations = true

    await runRelease(plan(), server, { home, user: "deploy" })

    const migrate = server.calls.indexOf("bun sixb check --migrate --lake")
    expect(server.calls.indexOf("systemctl stop sixb-northline@blue.service")).toBeGreaterThan(-1)
    expect(server.calls.indexOf("systemctl stop sixb-northline@blue.service")).toBeLessThan(migrate)
    // Nothing else runs the singletons, so green starts them at once.
    const green = slotLayout(deploymentLayout({ home, user: "deploy", name: "northline" }), "green")
    expect(
      (await server.readState(green.runDir))!.instances.every(
        (instance) => instance.status === "running"
      )
    ).toBe(true)
    expect(server.routedPort()).toBe("3011")
  })

  // Reproduce: drop the undo that starts blue again; a release that fails after migrating then
  // leaves nothing serving.
  test("starts blue again when the release fails after they ran", async () => {
    const server = new FakeServer()
    await liveInBlue(server)
    server.pendingMigrations = true
    server.ready = false

    const error = await runRelease(plan(), server, { home, user: "deploy" }).catch(
      (failure: unknown) => failure
    )

    expect(String(error)).toContain("The previous release, stopped for the migration, has started")
    expect(server.active).toEqual(new Set(["sixb-northline@blue.service"]))
    expect(server.routedPort()).toBe("3001")
  })

  test("without any, blue keeps serving throughout", async () => {
    const server = new FakeServer()
    await liveInBlue(server)

    await runRelease(plan(), server, { home, user: "deploy" })

    expect(server.calls).not.toContain("systemctl stop sixb-northline@blue.service")
    expect(server.calls).toContain("systemctl stop --no-block sixb-northline@blue.service")
  })
})

describe("the first slot deploy on a server from before slots", () => {
  // Reproduce: look only at `live-slot` in findLive; the old service then keeps serving and the
  // new one fails to bind its ports.
  test("adopts the running service as the live slot, then retires it", async () => {
    const server = new FakeServer()
    const layout = deploymentLayout({ home, user: "deploy", name: "northline" })
    const legacy = legacyLayout(layout)
    await legacyInGreen(server)

    await runRelease(plan(), server, { home, user: "deploy" })

    expect(server.calls).toContain("systemctl start sixb-northline@blue.service")
    expect(server.calls).toContain(`${layout.ctl} stop orchestrator`)
    expect(server.routedPort()).toBe("3001")
    expect(server.calls).toContain("systemctl stop --no-block sixb-northline.service")
    expect(server.calls).toContain("systemctl disable sixb-northline.service")
    expect(await readlink(layout.code)).toBe("current")
    expect(
      await readFile(join(layout.releasesDir, "legacy", PROJECT, "package.json"), "utf8")
    ).toBe("{}")
    expect(await Bun.file(legacy.unitPath).exists()).toBe(false)
    expect(await Bun.file(join(layout.deployDir, "ports.txt")).exists()).toBe(false)
  })

  // Reproduce: pass retire what still serves instead of what was live; the old service stays
  // enabled and starts beside the slot at the next boot.
  test("with migrations pending, still retires the service it stopped", async () => {
    const server = new FakeServer()
    const layout = deploymentLayout({ home, user: "deploy", name: "northline" })
    const legacy = legacyLayout(layout)
    await legacyInGreen(server)
    server.pendingMigrations = true

    await runRelease(plan(), server, { home, user: "deploy" })

    expect(server.calls).toContain("systemctl disable sixb-northline.service")
    expect(await Bun.file(legacy.unitPath).exists()).toBe(false)
    expect(await Bun.file(join(layout.deployDir, "ports.txt")).exists()).toBe(false)
  })

  // Reproduce: drop the `retireLegacy` call from "Start new release"; the next deploy then starts
  // green on the ports the old service still drains on.
  test("keeps its files while it drains, and the next deploy stops it first", async () => {
    const server = new FakeServer()
    const layout = deploymentLayout({ home, user: "deploy", name: "northline" })
    const legacy = legacyLayout(layout)
    const ports = join(layout.deployDir, "ports.txt")
    await legacyInGreen(server)
    server.drains.add(legacy.unit)

    await runRelease(plan(), server, { home, user: "deploy" })

    expect(server.active.has(legacy.unit)).toBe(true)
    expect(await Bun.file(legacy.unitPath).exists()).toBe(false)
    expect(await Bun.file(ports).exists()).toBe(true)

    await mkdir(join(layout.releasesDir, "r3", PROJECT), { recursive: true })
    server.calls.length = 0
    await runRelease(plan({ releaseId: "r3" }), server, { home, user: "deploy" })

    const startGreen = server.calls.indexOf("systemctl start sixb-northline@green.service")
    expect(server.calls.indexOf(`systemctl stop ${legacy.unit}`)).toBeGreaterThan(-1)
    expect(server.calls.indexOf(`systemctl stop ${legacy.unit}`)).toBeLessThan(startGreen)
    expect(server.active.has(legacy.unit)).toBe(false)
    expect(await Bun.file(ports).exists()).toBe(false)
  })
})

describe("carrying assets", () => {
  test("keeps the previous build's hashed chunks, so open tabs still load them", async () => {
    const previous = join(home, "previous")
    const next = join(home, "next")
    await mkdir(join(previous, ".sixb", "dist", "app", "assets"), { recursive: true })
    await mkdir(join(next, ".sixb", "dist", "app", "assets"), { recursive: true })
    await writeFile(join(previous, ".sixb", "dist", "app", "assets", "chunk-old.js"), "old")
    await writeFile(join(previous, ".sixb", "dist", "app", "index.html"), "old page")
    await writeFile(join(next, ".sixb", "dist", "app", "assets", "chunk-new.js"), "new")
    await writeFile(join(next, ".sixb", "dist", "app", "index.html"), "new page")

    await carryAssets(previous, next)

    const app = join(next, ".sixb", "dist", "app")
    expect(await readFile(join(app, "assets", "chunk-old.js"), "utf8")).toBe("old")
    expect(await readFile(join(app, "index.html"), "utf8")).toBe("new page")
    // Only one generation: the next deploy carries what this build made, not what it carried.
    expect(await readFile(join(next, ".sixb", "dist", ".own-assets"), "utf8")).toBe(
      "assets/chunk-new.js\nindex.html\n"
    )
  })
})
