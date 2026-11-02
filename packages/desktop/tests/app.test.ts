import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SixbDesktop } from "@sixb/client/hooks"
import { renderShellPage, writeDesktopApp } from "../src/generate"
import { bundleIdentifier, readAppIdentity } from "../src/identity"
import { desktopBridge } from "../src/shell/bridge"
import { pageWebPreferences } from "../src/shell/window"

const cleanup: (() => Promise<unknown> | undefined)[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((stop) => stop()))
})

const PNG_512 = new Uint8Array([137, 80, 78, 71, 5, 1, 2])
// A real image, one pixel, for the steps that draw with it.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

/** A PNG's width, from its header. */
function pngWidth(png: Uint8Array): number {
  return new DataView(png.buffer, png.byteOffset).getUint32(16)
}

/**
 * Runs a compiled preload as Electron's sandbox does, where `require` knows `electron` alone, over
 * a page with its `<html>` and body ready.
 */
function runPreload(code: string, platform: NodeJS.Platform) {
  const exposed: Record<string, unknown> = {}
  const root = {
    dataset: {} as Record<string, string | undefined>,
    style: { setProperty: () => {} },
  }
  let dragHandles = 0
  const document = {
    documentElement: root,
    readyState: "complete",
    body: { prepend: () => dragHandles++ },
    getElementById: () => null,
    createElement: () => ({ setAttribute: () => {} }),
  }
  const require = (name: string) => {
    if (name !== "electron") throw new Error(`module not found: ${name}`)
    return {
      contextBridge: {
        exposeInMainWorld: (key: string, value: unknown) => {
          exposed[key] = value
        },
      },
    }
  }
  new Function("require", "process", "document", code)(require, { platform }, document)
  return { exposed, mark: root.dataset.sixbDesktop, dragHandles }
}

/** Serves a web app manifest and its icons, the way `sixb dev` and a deployed app do. */
function serveApp(manifest: unknown): string {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === "/app.webmanifest") return Response.json(manifest)
      if (pathname === "/icon-512.png") return new Response(PNG_512)
      if (pathname === "/pixel.png") return new Response(PIXEL_PNG)
      if (pathname.endsWith(".png")) return new Response(new Uint8Array([137, 80, 78, 71]))
      return new Response("Not found", { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  return server.url.href
}

async function createProject(manifest: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-desktop-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest))
  return dir
}

describe("desktop app identity", () => {
  test("takes the name and the largest PNG icon from the app's manifest", async () => {
    const appUrl = serveApp({
      name: " Acme Orders ",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      ],
    })

    expect(await readAppIdentity(appUrl)).toEqual({ name: "Acme Orders", icon: PNG_512 })
  })

  test("prefers the maskable icon, drawn to its edges for a platform to shape", async () => {
    const appUrl = serveApp({
      name: "Acme Orders",
      icons: [
        { src: "/icon-1024.png", sizes: "1024x1024", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    })

    expect((await readAppIdentity(appUrl)).icon).toEqual(PNG_512)
  })

  test("works without icons", async () => {
    const appUrl = serveApp({ name: "Acme Orders" })

    expect(await readAppIdentity(appUrl)).toEqual({ name: "Acme Orders", icon: null })
  })

  test("says why when the app is not running", async () => {
    const appUrl = serveApp({ name: "Acme Orders" })
    await cleanup.pop()?.()

    await expect(readAppIdentity(appUrl)).rejects.toThrow("the app must be running there")
  })

  test("names each deployment's desktop app after its address", () => {
    expect(bundleIdentifier("https://orders.acme.com/")).toBe("com.acme.orders")
    expect(bundleIdentifier("https://orders.staging.acme.com/")).toBe("com.acme.staging.orders")
    expect(bundleIdentifier("http://localhost:3000/")).toBe("local.localhost")
  })
})

describe("generated desktop app", () => {
  test("carries the app it opens, its name, icon and the project's version", async () => {
    const projectRoot = await createProject({ name: "orders", version: "2.0.0" })
    const appUrl = serveApp({
      name: "Acme Orders",
      icons: [{ src: "/pixel.png", sizes: "1x1", type: "image/png" }],
    })

    const app = await writeDesktopApp({
      projectRoot,
      appUrl,
      apiOrigin: "https://api.acme.test/ignored/path",
    })

    expect(app).toEqual({
      dir: join(projectRoot, ".sixb", "desktop", "app"),
      name: "Acme Orders",
      version: "2.0.0",
      icon: join(app.dir, "icon.png"),
    })
    expect(JSON.parse(await readFile(join(app.dir, "shell.json"), "utf-8"))).toEqual({
      name: "Acme Orders",
      appUrl,
      apiOrigin: "https://api.acme.test",
    })
    expect(JSON.parse(await readFile(join(app.dir, "package.json"), "utf-8"))).toMatchObject({
      productName: "Acme Orders",
      version: "2.0.0",
      main: "main.js",
    })
    // On macOS the icon is redrawn on Apple's grid, on a 1024-pixel canvas.
    expect(pngWidth(await readFile(join(app.dir, "icon.png")))).toBe(
      process.platform === "darwin" ? 1024 : 1
    )
    const page = await readFile(join(app.dir, "index.html"), "utf-8")
    expect(page).toContain('<img class="mark" src="icon.png" alt="" />')
    expect(page).not.toContain("{{")
    expect(await Bun.file(join(app.dir, "main.js")).exists()).toBe(true)
    expect(await Bun.file(join(app.dir, "preload.js")).exists()).toBe(true)
  })

  // Guard proof: expose nothing from src/shell/preload.ts; useDesktop answers null. Use anything but
  // electron in the preload, such as node:path; Electron's sandbox refuses it, and the window has no
  // preload at all.
  // Append the drag handle instead of prepending it; it comes after the page's controls in document
  // order and re-covers the gaps cut for them, so buttons under it stop taking clicks.
  test.each([
    ["darwin", "inset"],
    ["linux", undefined],
    ["win32", undefined],
  ] as const)("offers the page its platform on %s, running under the sandbox's rules", async (platform, mark) => {
    const projectRoot = await createProject({ name: "orders", version: "1.0.0" })
    const appUrl = serveApp({ name: "Orders", icons: [] })
    const app = await writeDesktopApp({ projectRoot, appUrl, apiOrigin: appUrl })

    const page = runPreload(await readFile(join(app.dir, "preload.js"), "utf-8"), platform)

    expect(page.exposed).toEqual({ sixbDesktop: { platform } })
    expect(page.mark).toBe(mark)
    expect(page.dragHandles).toBe(mark ? 1 : 0)
  })

  // Guard proof: turn any of these off in pageWebPreferences; a remote page reaches Node, or the
  // preload's world.
  test("keeps the page sandboxed, with the preload its only way to the shell", () => {
    expect(pageWebPreferences("/app/preload.js")).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: "/app/preload.js",
    })
  })

  // Guard proof: return a different shape from desktopBridge; `bun run typecheck` fails here, where
  // the shell's bridge and the page's view of it meet.
  test("offers what the hook expects", () => {
    const bridge: SixbDesktop = desktopBridge("darwin")
    expect(bridge).toEqual({ platform: "darwin" })
  })

  test("clears what an earlier run left behind", async () => {
    const projectRoot = await createProject({ name: "orders" })
    const appUrl = serveApp({ name: "Acme Orders" })
    const stale = join(projectRoot, ".sixb", "desktop", "app", "icon.png")
    await writeDesktopApp({ projectRoot, appUrl, apiOrigin: appUrl })
    await writeFile(stale, PNG_512)

    const app = await writeDesktopApp({ projectRoot, appUrl, apiOrigin: appUrl })

    expect(app.icon).toBeNull()
    expect(app.version).toBe("0.0.0")
    expect(await Bun.file(stale).exists()).toBe(false)
  })
})

describe("loading page", () => {
  const appUrl = "https://app.acme.test/"

  test("escapes a name that would otherwise become markup", () => {
    const page = renderShellPage("<title>{{name}}</title><p>{{host}}</p>", {
      name: 'Orders <script>alert("x")</script>',
      appUrl,
      icon: false,
    })

    expect(page).toBe(
      "<title>Orders &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</title><p>app.acme.test</p>"
    )
  })

  test("shows the first letter of the name where the app has no icon", () => {
    const page = renderShellPage("{{mark}}", { name: " émile & co", appUrl, icon: false })

    expect(page).toBe('<div class="mark" aria-hidden="true">É</div>')
  })
})
