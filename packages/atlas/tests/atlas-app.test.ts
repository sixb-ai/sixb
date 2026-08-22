import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAtlasAssets, createAtlasApp } from "../src"

let assetsRoot: string
let assetsOutdir: string
const atlasDevelopmentFixturePath = join(import.meta.dir, "fixtures", "atlas-development-server.ts")
const atlasDevelopmentFixtureTimeoutMs = 30_000

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer() as ReturnType<typeof createServer> & {
      on(event: string, listener: (error: Error) => void): void
    }

    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }

      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(address.port)
      })
    })
  })
}

describe("createAtlasApp", () => {
  beforeAll(async () => {
    assetsRoot = await mkdtemp(join(tmpdir(), "sixb-atlas-assets-"))
    assetsOutdir = join(assetsRoot, "atlas")
    await buildAtlasAssets({ outdir: assetsOutdir })
  })

  afterAll(async () => {
    if (assetsRoot) {
      await rm(assetsRoot, { recursive: true, force: true })
    }
  })

  test("serves the public Atlas shell with API runtime config", async () => {
    const port = await getFreePort()
    const atlas = createAtlasApp({
      apiBaseUrl: "http://api.localhost",
      audience: "atlas",
    })
    const server = await atlas.start({
      host: "127.0.0.1",
      port,
      development: false,
      outdir: assetsOutdir,
    })

    try {
      const baseUrl = `http://127.0.0.1:${port}`
      const rootResponse = await fetch(`${baseUrl}/`)
      const routeResponse = await fetch(`${baseUrl}/devices`)
      const dottedRouteResponse = await fetch(`${baseUrl}/datasets/raw.ace.sites`)

      expect(rootResponse.status).toBe(200)
      expect(routeResponse.status).toBe(200)
      expect(dottedRouteResponse.status).toBe(200)

      const html = await rootResponse.text()
      const scriptPath = extractAssetPath(html, "script")
      const stylesheetPath = extractAssetPath(html, "stylesheet")
      const dottedRouteHtml = await dottedRouteResponse.text()

      expect(html).toContain('"api":{"baseUrl":"http://api.localhost"}')
      expect(html).toContain('"auth":{"audience":"atlas","enabled":true}')
      // The entry is named `atlas-*` and split chunks `chunk-*`, so the shell can never point at a
      // chunk. Naming both `[name]-[hash]` made `main.tsx` and its 47 shared chunks indistinguishable.
      expect(scriptPath).toMatch(/^\/__sixb\/atlas-[^.]+\.js$/)
      expect(stylesheetPath).toMatch(/^\/__sixb\/atlas-[^.]+\.css$/)
      expect(html).toContain('<div id="root"></div>')
      expect(dottedRouteHtml).toContain('<div id="root"></div>')

      for (const assetPath of [scriptPath, stylesheetPath]) {
        const assetResponse = await fetch(`${baseUrl}${assetPath}`)
        expect(assetResponse.status).toBe(200)
        expect(assetResponse.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable"
        )
      }

      const stableAssetResponse = await fetch(`${baseUrl}/__sixb/main.js`)
      expect(stableAssetResponse.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  test("serves disabled auth state in the Atlas shell", async () => {
    const port = await getFreePort()
    const atlas = createAtlasApp({
      apiBaseUrl: "http://api.localhost",
      audience: "atlas",
      authEnabled: false,
    })
    const server = await atlas.start({
      host: "127.0.0.1",
      port,
      development: false,
      outdir: assetsOutdir,
    })

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('"auth":{"audience":"atlas","enabled":false}')
    } finally {
      await server.stop()
    }
  })

  test("serves the development Atlas shell with Bun's HTML bundle", async () => {
    // Bun 1.3.14 keeps native HTML-bundler state for the life of a bun:test worker. In the full
    // two-file parallel suite, earlier HTML bundles can leave Atlas resolving a real
    // @tanstack/query-core index.js as a directory, so the dev route returns 500 with EISDIR. A
    // focused run starts with clean state and cannot reproduce it. Keep this one HTML import in a
    // bounded child: it still exercises the real development server and HTTP contract, while a
    // poisoned or wedged bundler is killable and cannot corrupt later tests.
    //
    // Guard check: move the fixture body back into this test, then run `bun run test:ci`; the Atlas
    // development case fails with EISDIR. The fixture itself must stay a real process, not a mock.
    await runAtlasDevelopmentFixture()
  }, 40_000)

  test("does not serve Sixb API-owned routes from the Atlas origin", async () => {
    const port = await getFreePort()
    const atlas = createAtlasApp({
      apiBaseUrl: "http://api.localhost",
      audience: "atlas",
    })
    const server = await atlas.start({
      host: "127.0.0.1",
      port,
      development: false,
      outdir: assetsOutdir,
    })

    try {
      const baseUrl = `http://127.0.0.1:${port}`
      for (const path of ["/api/project", "/auth/sign-in", "/ws/events", "/docs"]) {
        const response = await fetch(`${baseUrl}${path}`)
        expect(response.status).toBe(404)
      }
    } finally {
      await server.stop()
    }
  })

  test("fails clearly when production assets are missing", async () => {
    const port = await getFreePort()
    const atlas = createAtlasApp({
      apiBaseUrl: "http://api.localhost",
      audience: "atlas",
    })

    await expect(
      atlas.start({
        host: "127.0.0.1",
        port,
        development: false,
        outdir: join(assetsRoot, "missing"),
      })
    ).rejects.toThrow("Run `sixb build`")
  })
})

function extractAssetPath(html: string, kind: "script" | "stylesheet"): string {
  const pattern =
    kind === "script"
      ? /<script type="module" src="([^"]+)"><\/script>/
      : /<link rel="stylesheet" href="([^"]+)" \/>/
  const match = html.match(pattern)
  if (!match?.[1]) {
    throw new Error(`Could not find Atlas ${kind} asset path in shell HTML.`)
  }
  return match[1]
}

async function runAtlasDevelopmentFixture(): Promise<void> {
  const proc = Bun.spawn([process.execPath, "run", atlasDevelopmentFixturePath], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })

  // Drain both pipes while the child runs. Waiting for exit first can deadlock if a bundler error
  // fills either pipe, hiding the diagnostic this process boundary exists to preserve.
  const stdoutText = new Response(proc.stdout).text()
  const stderrText = new Response(proc.stderr).text()
  let timedOut = false
  const killTimer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, atlasDevelopmentFixtureTimeoutMs)

  try {
    const exitCode = await proc.exited
    const [stdout, stderr] = await Promise.all([stdoutText, stderrText])
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")

    if (timedOut) {
      throw new Error(
        `[SixbAtlasTest] Development server fixture exceeded ${atlasDevelopmentFixtureTimeoutMs}ms and was stopped.${output ? `\n${output}` : ""}`
      )
    }
    if (exitCode !== 0) {
      throw new Error(
        `[SixbAtlasTest] Development server fixture exited with code ${exitCode}.${output ? `\n${output}` : ""}`
      )
    }
  } finally {
    clearTimeout(killTimer)
    await Promise.all([stdoutText.catch(() => ""), stderrText.catch(() => "")])
  }
}
