import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { startRoleUntilReadyThenStop } from "./shared/cli-process"

// These boot a full production role (a long-running bun runtime) and wait for it
// to start, so they live as e2e tests: `bun test` skips `*.e2e.ts`, keeping them
// out of the heavily parallel unit run where subprocess cold-starts get starved.

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
const fixtureEntry = resolve(import.meta.dir, "fixtures", "prod-roles", "sixb.config.ts")

const ROLE_TIMEOUT_MS = 30_000

/**
 * `atlas` and `app` refuse to serve without the assets `sixb build` produces, so they
 * need a build output to point at.
 *
 * These are stand-ins, not a real build. What these tests measure is a role's startup
 * budget — which connections it opens and which it does not — and bundling Atlas to
 * measure that would add tens of seconds and put Bun's bundler on the path of a test
 * that has nothing to do with bundling. Atlas only requires the directory to exist with
 * exactly one `atlas-*.js` and one `atlas-*.css`; the custom app only requires an
 * `index.html`.
 */
const buildOutdir = resolve(dirname(fixtureEntry), ".sixb", "dist")

const PREBUILT_ATLAS = [
  join(buildOutdir, "atlas", "atlas-e2e.js"),
  join(buildOutdir, "atlas", "atlas-e2e.css"),
] as const

const PREBUILT_APP = [join(buildOutdir, "app", "index.html")] as const

/**
 * Each test writes only what its own role needs, and the output goes away afterwards.
 *
 * Writing both up front coupled tests that should know nothing about each other: `sixb
 * api` probes for a built custom app and serves it when one is present, so an
 * `app/index.html` left in place for the `app` test made the `api` test start demanding
 * `--app-public-origin`.
 */
async function writePrebuiltAssets(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      path.endsWith(".html") ? "<!doctype html><title>e2e</title>" : "/* e2e */"
    )
  }
}

const tempDirs: string[] = []

interface PortReservation {
  readonly port: number
  readonly close: () => Promise<void>
}

afterEach(async () => {
  await rm(buildOutdir, { recursive: true, force: true })

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

async function reserveFreePort(): Promise<PortReservation> {
  return await new Promise<PortReservation>((resolvePromise, reject) => {
    const server = createServer()
    const fail = (error: Error) => {
      reject(error)
    }

    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail)
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Could not reserve a free TCP port"))
        return
      }

      resolvePromise({
        port: address.port,
        close: async () => {
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error)
              } else {
                resolveClose()
              }
            })
          })
        },
      })
    })
  })
}

async function getFreePorts(count: number): Promise<readonly number[]> {
  const reservations: PortReservation[] = []

  try {
    for (let index = 0; index < count; index += 1) {
      reservations.push(await reserveFreePort())
    }

    return reservations.map((reservation) => reservation.port)
  } finally {
    await Promise.all(reservations.map((reservation) => reservation.close()))
  }
}

/** The fixture logs `{ type }` objects; the reader hands them back untyped. */
function eventTypes(logEntries: readonly Record<string, unknown>[]): string[] {
  return logEntries.map((entry) => String(entry.type))
}

async function startRole(args: readonly string[]) {
  const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-roles-"))
  const logPath = join(tempDir, "operations.log")
  tempDirs.push(tempDir)

  return startRoleUntilReadyThenStop({
    cmd: ["bun", cliEntry, ...args, "--entry", fixtureEntry],
    cwd: repoRoot,
    logPath,
  })
}

const backgroundRoles: Array<{
  name: string
  command: readonly string[]
  expectProviderClose?: boolean
}> = [
  { name: "orchestrator", command: ["orchestrator"] },
  { name: "scheduler", command: ["scheduler"] },
  { name: "rules", command: ["rules"] },
  { name: "worker sync", command: ["worker", "sync"], expectProviderClose: true },
]

describe("role startup connection budget", () => {
  for (const role of backgroundRoles) {
    test(
      `sixb ${role.name} migrates storage at startup without touching lake storage`,
      async () => {
        const { ready, logEntries } = await startRole(role.command)

        expect(ready).toBe(true)
        // A role brings the storage schema up to date before it serves. `sixb db migrate`
        // used to be a release step an operator had to remember, and forgetting it surfaced
        // as a missing column on the first request — far from the cause. Replicas do not
        // stampede: Postgres serializes migrators on an advisory lock and late ones no-op.
        expect(logEntries).toContainEqual({ type: "storage:migrate" })
        // No `storage:plan` assertion here: these roles never probe the schema at all
        // (startSchemaValidation hangs off SixbServer.start), so it would pass whatever
        // the probe does. It lives in the `api` test below, where it bites.
        // Roles do not open the lake catalog at startup either.
        expect(logEntries.some((entry) => entry.type === "lake:assert")).toBe(false)
        if (role.expectProviderClose) {
          expect(logEntries).toContainEqual({ type: "queues:close" })
          expect(logEntries).toContainEqual({ type: "lake-storage:close" })
          expect(logEntries).toContainEqual({ type: "storage:close" })

          // Order, not just presence. Storage closes last of the three because the
          // broker's final outbox drain reads from it; closing storage first would
          // lose whatever that drain had left to publish.
          const closes = eventTypes(logEntries).filter((type) => type.endsWith(":close"))
          expect(closes.indexOf("queues:close")).toBeLessThan(closes.indexOf("storage:close"))
        }
      },
      ROLE_TIMEOUT_MS
    )
  }

  test(
    "sixb api migrates storage before probing the schema, without touching lake storage",
    async () => {
      const [atlasPort, apiPort] = await getFreePorts(2)
      const { ready, logEntries } = await startRole([
        "api",
        "--port",
        String(atlasPort),
        "--host",
        "127.0.0.1",
        "--api-host",
        "127.0.0.1",
        "--api-port",
        String(apiPort),
        "--api-public-origin",
        `http://localhost:${apiPort}`,
        "--atlas-public-origin",
        `http://localhost:${atlasPort}`,
      ])

      expect(ready).toBe(true)
      expect(logEntries.some((entry) => entry.type === "lake:assert")).toBe(false)

      // `api` is the only role that probes the schema at boot: startSchemaValidation()
      // hangs off SixbServer.start(), so the four background roles never reach it. That
      // makes this the one place the read-only-probe rule can be enforced, and asserting
      // it in the shared loop above would have been vacuous.
      expect(logEntries).toContainEqual({ type: "storage:status" })
      // `plan()` runs CREATE SCHEMA / CREATE TABLE through ensure(). A public,
      // unauthenticated /ready and every api boot go through this path.
      expect(logEntries.some((entry) => entry.type === "storage:plan")).toBe(false)

      // Order, not just presence. The probe answers an unauthenticated /ready, so it has
      // to observe the schema the migration left behind rather than race it — otherwise
      // the first /ready of a freshly migrated deployment reports a stale state.
      const types = eventTypes(logEntries)
      expect(types.indexOf("storage:migrate")).toBeGreaterThanOrEqual(0)
      expect(types.indexOf("storage:migrate")).toBeLessThan(types.indexOf("storage:status"))
    },
    ROLE_TIMEOUT_MS
  )

  test(
    "sixb atlas serves the built UI without touching storage or the lake",
    async () => {
      await writePrebuiltAssets(PREBUILT_ATLAS)
      const [atlasPort, apiPort] = await getFreePorts(2)
      const { ready, logEntries } = await startRole([
        "atlas",
        "--port",
        String(atlasPort),
        "--host",
        "127.0.0.1",
        "--api-public-origin",
        `http://localhost:${apiPort}`,
        "--atlas-public-origin",
        `http://localhost:${atlasPort}`,
      ])

      expect(ready).toBe(true)
      // The counterpart of every other role's assertion, and the reason `atlas` is off the
      // `StorageSchemaRole` union: it serves a browser bundle, it is the tier that faces the
      // internet, and a container shipping assets has no business holding a DDL grant. Until
      // now that exclusion rested only on a compile error.
      expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
      expect(logEntries.some((entry) => entry.type === "storage:status")).toBe(false)
      expect(logEntries.some((entry) => entry.type === "storage:plan")).toBe(false)
      expect(logEntries.some((entry) => entry.type === "lake:assert")).toBe(false)
      // It still shuts its providers down: the runtime is loaded even though unused.
      expect(logEntries).toContainEqual({ type: "storage:close" })
    },
    ROLE_TIMEOUT_MS
  )

  test(
    "sixb app serves the built custom app without touching storage or the lake",
    async () => {
      await writePrebuiltAssets(PREBUILT_APP)
      const [appPort, apiPort] = await getFreePorts(2)
      const { ready, logEntries } = await startRole([
        "app",
        "--port",
        String(appPort),
        "--host",
        "127.0.0.1",
        "--api-public-origin",
        `http://localhost:${apiPort}`,
        "--app-public-origin",
        `http://localhost:${appPort}`,
      ])

      expect(ready).toBe(true)
      expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
      expect(logEntries.some((entry) => entry.type === "storage:status")).toBe(false)
      expect(logEntries.some((entry) => entry.type === "lake:assert")).toBe(false)
      expect(logEntries).toContainEqual({ type: "storage:close" })
    },
    ROLE_TIMEOUT_MS
  )

  test(
    "sixb rules --no-migrate starts without migrating storage",
    async () => {
      const { ready, logEntries } = await startRole(["rules", "--no-migrate"])

      expect(ready).toBe(true)
      expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
    },
    ROLE_TIMEOUT_MS
  )
})
