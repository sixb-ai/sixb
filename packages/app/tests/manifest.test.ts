import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateAppEntry } from "../src/codegen"

interface GeneratedFixture {
  readonly root: string
  readonly appDir: string
  readonly publicDir: string
  readonly generatedDir: string
}

async function createFixture(): Promise<GeneratedFixture> {
  const root = await mkdtemp(join(tmpdir(), "sixb-app-manifest-"))
  const appDir = join(root, "app")
  const publicDir = join(appDir, "public")
  const generatedDir = join(root, ".sixb", "generated")
  await mkdir(publicDir, { recursive: true })
  return { root, appDir, publicDir, generatedDir }
}

async function writeLayout(fixture: GeneratedFixture, metadataSource: string): Promise<void> {
  await writeFile(
    join(fixture.appDir, "layout.tsx"),
    `export const metadata = ${metadataSource}\nexport default function Layout() { return null }\n`
  )
}

describe("custom app metadata and manifest generation", () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  test("uses stable defaults and omits unresolved optional identity", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)

    const { htmlPath, mainPath, manifestPath } = await generateAppEntry(
      fixture.root,
      fixture.generatedDir
    )
    const html = await readFile(htmlPath, "utf-8")
    const main = await readFile(mainPath, "utf-8")
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"))

    expect(manifest).toEqual({
      id: "/",
      name: "Sixb",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#ffffff",
      background_color: "#ffffff",
    })
    expect(html).toContain("<title>Sixb</title>")
    expect(html).toContain('<meta name="theme-color" content="#ffffff" />')
    expect(html).toContain('<link rel="manifest" href="/app.webmanifest" />')
    expect(html).not.toContain('name="description"')
    expect(html).not.toContain('rel="icon"')
    expect(html).not.toContain('rel="apple-touch-icon"')
    expect(main).not.toContain("applyMetadata")
    expect(main).not.toContain("{ metadata }")
  })

  test("renders escaped static metadata and all conventional icons", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    await writeLayout(
      fixture,
      JSON.stringify({
        title: 'Sixb <Counter> & "Tools"',
        description: 'Count <things> & call them "done"',
        favicon: '/favicon.svg?label="sixb"&mode=app',
        themeColor: '#0b0b0f" data-test="nope',
        backgroundColor: "#101016",
      })
    )
    for (const name of [
      "favicon.svg",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-512.png",
      "apple-touch-icon.png",
    ]) {
      await writeFile(join(fixture.publicDir, name), name)
    }

    const { htmlPath, manifestPath } = await generateAppEntry(fixture.root, fixture.generatedDir)
    const html = await readFile(htmlPath, "utf-8")
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"))

    expect(html).toContain('<title>Sixb &lt;Counter&gt; &amp; "Tools"</title>')
    expect(html).toContain('content="Count &lt;things&gt; &amp; call them &quot;done&quot;"')
    expect(html).toContain('content="#0b0b0f&quot; data-test=&quot;nope"')
    expect(html).toContain('href="/favicon.svg?label=&quot;sixb&quot;&amp;mode=app"')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(manifest).toEqual({
      id: "/",
      name: 'Sixb <Counter> & "Tools"',
      description: 'Count <things> & call them "done"',
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: '#0b0b0f" data-test="nope',
      background_color: "#101016",
      icons: [
        {
          src: "/icon-192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/icon-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/icon-maskable-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    })
  })

  test("discovers a conventional SVG favicon and uses it as the manifest fallback", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    await writeFile(join(fixture.publicDir, "favicon.svg"), "<svg></svg>\n")

    const { htmlPath, manifestPath } = await generateAppEntry(fixture.root, fixture.generatedDir)
    const html = await readFile(htmlPath, "utf-8")
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"))

    expect(html).toContain('<link rel="icon" href="/favicon.svg" />')
    expect(manifest.icons).toEqual([
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ])
  })

  test("uses background color as the theme fallback and rejects invalid fields", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    await writeLayout(fixture, JSON.stringify({ backgroundColor: "#121212" }))

    const { manifestPath } = await generateAppEntry(fixture.root, fixture.generatedDir)
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"))
    expect(manifest.theme_color).toBe("#121212")
    expect(manifest.background_color).toBe("#121212")

    await writeLayout(fixture, JSON.stringify({ themeColor: "  " }))
    expect(generateAppEntry(fixture.root, fixture.generatedDir)).rejects.toThrow(
      "[SixbCustomApp] Invalid app metadata"
    )
    expect(generateAppEntry(fixture.root, fixture.generatedDir)).rejects.toThrow(
      "metadata.themeColor must be a non-empty string"
    )
  })

  test("builds a stable manifest and cannot be shadowed by a public manifest", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    await writeFile(
      join(fixture.appDir, "page.tsx"),
      "export default function Page() { return <main>Built app</main> }\n"
    )
    await writeLayout(fixture, JSON.stringify({ title: "Built PWA", favicon: "/favicon.svg" }))
    await writeFile(join(fixture.publicDir, "favicon.svg"), "<svg></svg>\n")
    await writeFile(join(fixture.publicDir, "icon-192.png"), "fixture png")
    await writeFile(join(fixture.publicDir, "app.webmanifest"), '{"name":"Shadow"}\n')
    const fixtureModules = join(fixture.root, "node_modules")
    await mkdir(join(fixtureModules, "@tanstack"), { recursive: true })
    await mkdir(join(fixtureModules, "@sixb"), { recursive: true })
    for (const dependency of ["react", "react-dom", "react-router-dom"]) {
      await symlink(
        join(process.cwd(), "packages", "app", "node_modules", dependency),
        join(fixtureModules, dependency),
        "dir"
      )
    }
    await symlink(
      join(process.cwd(), "packages", "app", "node_modules", "@tanstack", "react-query"),
      join(fixtureModules, "@tanstack", "react-query"),
      "dir"
    )
    await symlink(
      join(process.cwd(), "packages", "cli", "node_modules", "@sixb", "client"),
      join(fixtureModules, "@sixb", "client"),
      "dir"
    )

    // Keep Bun.build in a disposable process. A completed in-process split build leaves bundler
    // state that can break a later HTML dev bundle in the same bun:test process.
    const buildScript = join(fixture.root, "run-build.ts")
    const createCustomAppPath = join(import.meta.dir, "..", "src", "createCustomApp.ts")
    await writeFile(
      buildScript,
      [
        `import { createCustomApp } from ${JSON.stringify(createCustomAppPath)}`,
        `const app = await createCustomApp({ rootDir: ${JSON.stringify(fixture.root)}, authEnabled: false, agentRoutes: false })`,
        "const result = await app.build()",
        "if (!result.success) throw new Error((result.logs ?? []).join('\\n'))",
        "",
      ].join("\n")
    )
    const proc = Bun.spawn([process.execPath, "run", buildScript], {
      cwd: fixture.root,
      stdout: "ignore",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(await new Response(proc.stderr).text())
    }

    const outdir = join(fixture.root, ".sixb", "dist", "app")
    const builtHtml = await readFile(join(outdir, "index.html"), "utf-8")
    const builtManifest = JSON.parse(await readFile(join(outdir, "app.webmanifest"), "utf-8"))
    expect(builtHtml).toContain('href="/app.webmanifest"')
    expect(builtHtml).toContain('href="/favicon.svg"')
    expect(builtHtml).toContain('class="sixb-loading-shell"')
    expect(builtHtml).not.toContain("main.tsx")
    const scriptFile = builtHtml.match(/src="\/(app-[a-z0-9]+\.js)"/)?.[1]
    expect(scriptFile).toBeDefined()
    expect(await Bun.file(join(outdir, `${scriptFile}.br`)).exists()).toBe(true)
    expect(await Bun.file(join(outdir, `${scriptFile}.gz`)).exists()).toBe(true)
    expect(builtManifest.name).toBe("Built PWA")
    expect(builtManifest.icons[0].src).toBe("/icon-192.png")
    expect(await readFile(join(outdir, "icon-192.png"), "utf-8")).toBe("fixture png")
  })

  test("does not rewrite unchanged HTML or manifest output", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    await writeLayout(fixture, JSON.stringify({ title: "Stable" }))

    const first = await generateAppEntry(fixture.root, fixture.generatedDir)
    const before = await Promise.all(
      [first.htmlPath, first.mainPath, first.manifestPath].map(
        async (path) => (await stat(path)).mtimeMs
      )
    )
    await Bun.sleep(25)
    const second = await generateAppEntry(fixture.root, fixture.generatedDir)
    const after = await Promise.all(
      [second.htmlPath, second.mainPath, second.manifestPath].map(
        async (path) => (await stat(path)).mtimeMs
      )
    )

    expect(after).toEqual(before)
    expect(await readFile(second.manifestPath, "utf-8")).toEndWith("\n")
  })
})
