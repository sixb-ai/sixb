import { expect, test } from "bun:test"
import { readFile, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import {
  actionSource,
  createDevFixture,
  objectSource,
  pageSource,
  pipelineSource,
} from "./shared/dev-fixture"

const cli = resolve(import.meta.dir, "../src/index.tsx")

function request(input: string, options: RequestInit = {}) {
  return fetch(input, { ...options, signal: AbortSignal.timeout(3000) })
}

async function waitFor(check: () => boolean | Promise<boolean>, details: () => string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out: ${details()}`)
}

function freePortBlock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 30_000)
    const reservations: ReturnType<typeof Bun.serve>[] = []
    try {
      for (let offset = 0; offset < 3; offset++) {
        reservations.push(
          Bun.serve({ hostname: "127.0.0.1", port: port + offset, fetch: () => new Response() })
        )
      }
      return port
    } catch {
      // Try another block while holding all three reservations together.
    } finally {
      for (const server of reservations) server.stop(true)
    }
  }
  throw new Error("No free dev port block")
}

// Guard check: return immediately from the watchDevSource callback in lib/dev-supervisor.ts.
// This test then fails waiting for the first helper edit to restart the running app.
test("dev reloads backend modules, rediscovers files, recovers, and keeps frontend HMR", async () => {
  const fixture = await createDevFixture()
  const port = freePortBlock()
  const api = `http://127.0.0.1:${port + 2}`
  const atlas = `http://127.0.0.1:${port}`
  const app = `http://127.0.0.1:${port + 1}`
  let output = ""
  const proc = Bun.spawn(
    [
      process.execPath,
      cli,
      "dev",
      "--entry",
      join(fixture.root, "sixb.config.ts"),
      "--port",
      String(port),
    ],
    {
      cwd: fixture.root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    }
  )
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
      }
    } finally {
      reader.releaseLock()
    }
  }
  const readers = [capture(proc.stdout), capture(proc.stderr)]
  // Bun's test deadline does not cancel an in-flight async operation. Own the
  // subprocess lifetime independently so even a hung assertion cannot orphan it.
  const processDeadline = setTimeout(() => proc.kill("SIGTERM"), 100_000)
  const events = async () =>
    (await readFile(join(fixture.root, ".sixb/events.log"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string
            pid: number
            value?: string
          }
      )
  const readyCount = () => [...output.matchAll(/\[SixbDev\] Ready/g)].length
  const waitReady = async (count: number) =>
    waitFor(
      () => readyCount() >= count,
      () => output
    )
  const generation = async (origin = atlas) =>
    (
      await request(`${origin}/__sixb/dev-reload.js`, {
        method: "HEAD",
        signal: AbortSignal.timeout(2000),
      })
    ).headers.get("x-sixb-dev-generation")
  const edit = async (path: string, source: string) => {
    const count = readyCount()
    await fixture.write(path, source)
    await waitFor(
      () => readyCount() >= count + 1,
      () => `edit ${path}:\n${output}`
    )
  }
  const runAction = async (value: string) => {
    const response = await request(`${api}/api/actions/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(202)
    const requested = (await response.json()) as { runId: string }
    let status = ""
    await waitFor(
      async () => {
        status = await (await request(`${api}/api/action-runs/${requested.runId}`)).text()
        return (await events()).some((e) => e.type === "action" && e.value === value)
      },
      () => `${status}\n${output}`
    )
  }
  const runPipeline = async (value: string) => {
    const response = await request(`${api}/api/pipelines/copy/runs`, { method: "POST" })
    expect(response.status).toBe(202)
    const requested = (await response.json()) as { runId: string }
    let status = ""
    await waitFor(
      async () => {
        status = await (await request(`${api}/api/pipeline-runs/${requested.runId}`)).text()
        return (await events()).some((e) => e.type === "pipeline" && e.value === value)
      },
      () => `${status}\n${output}`
    )
  }
  let reloads = 0
  let browserStopped = false
  const browserTimers = new Set<ReturnType<typeof setTimeout>>()
  try {
    await waitReady(1)
    const originalGeneration = await generation()
    expect(originalGeneration).toBeTruthy()
    // Execute the actual served browser script against real HTTP. The browser can
    // outlive the dev child and must reload once, only after the replacement is ready.
    runInNewContext(await (await request(`${atlas}/__sixb/dev-reload.js`)).text(), {
      window: {},
      document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
      location: {
        reload() {
          reloads++
        },
      },
      AbortSignal,
      clearTimeout,
      fetch: (path: string, options: RequestInit) => fetch(`${atlas}${path}`, options),
      setTimeout(callback: () => void, delay: number) {
        if (browserStopped) return
        const timer = setTimeout(callback, delay)
        browserTimers.add(timer)
        return timer
      },
    })
    await runAction("first")
    await edit("lib/value.ts", 'export const value = "second"\n')
    expect(await generation()).not.toBe(originalGeneration)
    await waitFor(
      () => reloads === 1,
      () => output
    )
    await runAction("second")
    await edit("actions/report.ts", actionSource("-edited"))
    await runAction("second-edited")
    await runPipeline("pipeline-first")
    await edit("pipelines/copy.ts", pipelineSource("pipeline-edited"))
    await runPipeline("pipeline-edited")

    await edit("ontology/nested/Added.ts", objectSource("Added"))
    expect((await request(`${api}/api/object-types/Added`)).status).toBe(200)
    const manifest = join(fixture.root, ".sixb/types/ontology.d.ts")
    expect(await readFile(manifest, "utf8")).toContain("Added")
    let count = readyCount()
    await rename(
      join(fixture.root, "ontology/nested/Added.ts"),
      join(fixture.root, "ontology/nested/Renamed.ts")
    )
    await waitReady(count + 1)
    expect(await readFile(manifest, "utf8")).toContain("Renamed")
    count = readyCount()
    await rm(join(fixture.root, "ontology/nested"), { recursive: true })
    await waitReady(count + 1)
    expect((await request(`${api}/api/object-types/Added`)).status).toBe(404)
    expect(await readFile(manifest, "utf8")).not.toContain("Added")

    const errorStart = output.length
    await fixture.write("lib/value.ts", "export const value = ;")
    await waitFor(
      () => output.slice(errorStart).includes("Waiting for source changes"),
      () => output
    )
    expect(proc.exitCode).toBeNull()
    await edit("lib/value.ts", 'export const value = "recovered"\n')
    await runAction("recovered-edited")

    // First route must start the app server even though app/ did not exist at boot.
    await edit("app/page.tsx", pageSource("Frontend first"))
    const appResponse = await request(app)
    if (appResponse.status !== 200) throw new Error(await appResponse.text())
    expect(await generation(app)).toBe(await generation())
    expect(await (await request(app)).text()).toContain("/__sixb/dev-reload.js")
    const stableGeneration = await generation()
    count = readyCount()
    await fixture.write("app/page.tsx", pageSource("Frontend edited"))
    await fixture.write(".sixb/generated/ignored.ts", "export const ignored = true")
    await fixture.write("data.db", "storage data")
    await fixture.write("blob-without-extension", "storage data")
    // A negative assertion needs a window longer than the debounce and normal restart.
    await Bun.sleep(1500)
    expect(readyCount()).toBe(count)
    expect(await generation()).toBe(stableGeneration)

    // Saves during a slow startup must still land on the latest transitive import.
    const configPath = join(fixture.root, "sixb.config.ts")
    const config = await readFile(configPath, "utf8")
    const beforeStarts = (await events()).filter((e) => e.type === "start").length
    await fixture.write(
      "sixb.config.ts",
      config.replace('log("start")', 'log("start"); await Bun.sleep(700)')
    )
    await waitFor(
      async () => (await events()).filter((e) => e.type === "start").length > beforeStarts,
      () => output
    )
    await fixture.write("lib/value.ts", 'export const value = "during-startup"\n')
    await waitReady(count + 1)
    await runAction("during-startup-edited")

    proc.kill("SIGTERM")
    await waitFor(
      () => proc.exitCode !== null,
      () => output
    )
    expect(proc.exitCode).toBe(0)
    const history = await events()
    const starts = history.filter((event) => event.type === "start")
    for (const event of starts) {
      expect(() => process.kill(event.pid, 0)).toThrow()
    }
    // Every fully booted generation closed its provider before a replacement started.
    for (const match of output.matchAll(/\[SixbDev\] Ready \(pid (\d+)\)/g)) {
      const pid = Number(match[1])
      const start = history.findIndex((event) => event.type === "start" && event.pid === pid)
      const close = history.findIndex((event) => event.type === "close" && event.pid === pid)
      const next = history.findIndex((event, index) => index > start && event.type === "start")
      expect(close).toBeGreaterThan(start)
      if (next !== -1) expect(close).toBeLessThan(next)
    }
    expect(history.at(-1)?.type).toBe("close")
  } catch (error) {
    throw new Error(output, { cause: error })
  } finally {
    clearTimeout(processDeadline)
    browserStopped = true
    for (const timer of browserTimers) clearTimeout(timer)
    if (proc.exitCode === null) proc.kill("SIGTERM")
    const kill = setTimeout(() => proc.kill("SIGKILL"), 12_000)
    await proc.exited
    clearTimeout(kill)
    await Promise.all(readers)
    await rm(fixture.root, { recursive: true, force: true })
  }
}, 120_000)

// Guard check: replace terminate()'s process-group kill with current.process.kill(signal).
// On macOS/Linux the descendant survives and this test fails the final liveness assertion.
// Also remove the child-side disconnect deadline in commands/dev.tsx: SIGKILL of
// the supervisor then leaves the stuck child and its descendant alive.
for (const signal of ["SIGTERM", "SIGKILL"] as const)
  test.skipIf(process.platform === "win32")(
    `dev reaps a stuck startup and descendants after supervisor ${signal}`,
    async () => {
      const fixture = await createDevFixture()
      const marker = join(fixture.root, ".sixb/blocked.json")
      await fixture.write(
        "sixb.config.ts",
        `
import { writeFileSync } from "node:fs"
const descendant = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
  stdin: "ignore", stdout: "ignore", stderr: "ignore"
})
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ child: process.pid, descendant: descendant.pid }))
await new Promise(() => {})
`
      )
      const proc = Bun.spawn(
        [process.execPath, cli, "dev", "--entry", join(fixture.root, "sixb.config.ts")],
        {
          cwd: fixture.root,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        }
      )
      const stderr = new Response(proc.stderr).text()
      let exited = false
      void proc.exited.then(() => {
        exited = true
      })
      let pids: { child: number; descendant: number } | undefined
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      try {
        await waitFor(
          () => Bun.file(marker).exists(),
          () => "startup marker missing"
        )
        pids = (await Bun.file(marker).json()) as typeof pids
        expect(pids).toBeDefined()
        proc.kill(signal)
        await waitFor(
          () => exited,
          () => "supervisor did not stop"
        )
        if (signal === "SIGTERM") {
          expect(proc.exitCode).toBe(0)
          expect(await stderr).toContain("Shutdown timed out")
        } else {
          expect(proc.signalCode).toBe("SIGKILL")
        }
        const stoppedPids = pids
        await waitFor(
          () => !!stoppedPids && !alive(stoppedPids.child) && !alive(stoppedPids.descendant),
          () => "dev child or descendant survived"
        )
      } finally {
        if (proc.exitCode === null) proc.kill("SIGKILL")
        await proc.exited
        if (pids)
          for (const pid of [pids.child, pids.descendant]) {
            if (alive(pid)) process.kill(pid, "SIGKILL")
          }
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    60_000
  )

// Guard: remove scheduleFallback() from dev-watch.ts. Native events are deliberately
// absent in this isolated subprocess, so the backend edit is then never reported.
test("source reconciliation recovers missing native events and closes its timers", async () => {
  const fixture = await createDevFixture()
  await fixture.write("app/page.tsx", pageSource("Initial"))
  const code = `
import { mock } from "bun:test"
import { EventEmitter } from "node:events"
import { writeFile } from "node:fs/promises"
mock.module("node:fs", () => ({ watch: () => Object.assign(new EventEmitter(), { close() {} }) }))
const { watchDevSource } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/lib/dev-watch.ts"))})
const changes = []
const errors = []
const watcher = watchDevSource(${JSON.stringify(fixture.root)}, () => true, (path) => changes.push(path), (error) => errors.push(String(error)))
await watcher.ready
await writeFile(${JSON.stringify(join(fixture.root, "app/page.tsx"))}, "export default () => null")
await writeFile(${JSON.stringify(join(fixture.root, "lib/value.ts"))}, 'export const value = "changed"')
const deadline = Date.now() + 7000
while (changes.length === 0 && Date.now() < deadline) await Bun.sleep(20)
await watcher.close()
console.log(JSON.stringify({ changes, errors }))
`
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: fixture.root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()
  const deadline = setTimeout(() => proc.kill("SIGKILL"), 10_000)
  try {
    expect(await proc.exited).toBe(0)
    expect(await stderr).toBe("")
    expect(JSON.parse(await stdout)).toEqual({ changes: ["lib/value.ts"], errors: [] })
  } finally {
    clearTimeout(deadline)
    if (proc.exitCode === null) proc.kill("SIGKILL")
    await proc.exited
    await rm(fixture.root, { recursive: true, force: true })
  }
}, 15_000)
