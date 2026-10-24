import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
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
    const manifestText = await readFile(manifestPath, "utf-8")
    const manifest = JSON.parse(manifestText)

    expect(manifestText).toEndWith("\n")
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
    const error = await generateAppEntry(fixture.root, fixture.generatedDir).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("[SixbCustomApp] Invalid app metadata")
    expect(error.message).toContain("metadata.themeColor must be a non-empty string")
  })

  // Regression proof: remove validateVisibility's call in metadata.ts and both rejections fail.
  test("rejects a visibility export with an unknown section or values that are not groups", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    const writeVisibility = (source: string) =>
      writeFile(
        join(fixture.appDir, "layout.tsx"),
        `export const visibility = ${source}\nexport default function Layout() { return null }\n`
      )

    await writeVisibility(`{ settings: [{ kind: "group", id: "admins" }] }`)
    await generateAppEntry(fixture.root, fixture.generatedDir)

    await writeVisibility(`{ settings: [{ kind: "group", id: "admins" }], data: [] }`)
    await generateAppEntry(fixture.root, fixture.generatedDir)

    await writeVisibility(`{ billing: [] }`)
    await expect(generateAppEntry(fixture.root, fixture.generatedDir)).rejects.toThrow(
      "'billing' is not a built-in section. Sections: data, observability, ontology, settings."
    )

    await writeVisibility(`{ settings: ["admins"] }`)
    await expect(generateAppEntry(fixture.root, fixture.generatedDir)).rejects.toThrow(
      "visibility.settings must be a list of groups"
    )
  })

  // Regression proof: remove the agentToolViews call in metadata.ts and the three rejections fail;
  // the app would then generate and fail only in the browser.
  test("rejects a toolViews export that is not a list of views, one per tool", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    const view = (toolName: string) =>
      `{ kind: "agentToolView", toolName: "${toolName}", placement: "work", render: () => null }`
    const writeToolViews = (source: string) =>
      writeFile(
        join(fixture.appDir, "layout.tsx"),
        `export const toolViews = ${source}\nexport default function Layout() { return null }\n`
      )

    await writeToolViews(`[${view("quote_shipping")}, ${view("count_rows")}]`)
    await generateAppEntry(fixture.root, fixture.generatedDir)

    await writeToolViews(view("quote_shipping"))
    await expect(generateAppEntry(fixture.root, fixture.generatedDir)).rejects.toThrow(
      "[SixbCustomApp] Invalid toolViews in"
    )

    await writeToolViews(`[${view("quote_shipping")}, "count_rows"]`)
    await expect(generateAppEntry(fixture.root, fixture.generatedDir)).rejects.toThrow(
      "toolViews[1] is not a view from defineAgentToolView."
    )

    await writeToolViews(`[${view("quote_shipping")}, ${view("quote_shipping")}]`)
    await expect(generateAppEntry(fixture.root, fixture.generatedDir)).rejects.toThrow(
      "two views for the tool 'quote_shipping'. Keep one view per tool."
    )
  })

  // Regression proof: in metadata.ts, clear only the layout from the module cache and the second
  // generation fails again on the duplicate that was already fixed in its own file.
  test("reads a view again once it is fixed in its own file", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    const writeCountView = (toolName: string) =>
      writeFile(
        join(fixture.appDir, "_agent", "count-view.ts"),
        `export const countView = { kind: "agentToolView", toolName: "${toolName}", placement: "work", render: () => null }\n`
      )

    await mkdir(join(fixture.appDir, "_agent"), { recursive: true })
    await writeFile(
      join(fixture.appDir, "_agent", "quote-view.ts"),
      `export const quoteView = { kind: "agentToolView", toolName: "quote_shipping", placement: "work", render: () => null }\n`
    )
    await writeCountView("quote_shipping")
    await writeFile(
      join(fixture.appDir, "layout.tsx"),
      [
        `import { quoteView } from "./_agent/quote-view"`,
        `import { countView } from "./_agent/count-view"`,
        "export const toolViews = [quoteView, countView]",
        "export default function Layout() { return null }",
        "",
      ].join("\n")
    )

    await expect(generateAppEntry(fixture.root, fixture.generatedDir)).rejects.toThrow(
      "two views for the tool 'quote_shipping'"
    )

    await writeCountView("count_rows")
    await generateAppEntry(fixture.root, fixture.generatedDir)
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
    // The generated runtime takes its locale provider from @sixb/app, never from the project's
    // own dependencies: this fixture deliberately has no @sixb/ui.
    await symlink(
      join(process.cwd(), "packages", "app"),
      join(fixtureModules, "@sixb", "app"),
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
        `const app = await createCustomApp({ rootDir: ${JSON.stringify(fixture.root)}, authEnabled: false, builtInPages: false })`,
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
    const stderr = new Response(proc.stderr).text()
    // A wedged bundler is killed at this bound instead of outliving the test.
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 20_000)
    const exitCode = await proc.exited.finally(() => clearTimeout(killTimer))
    if (exitCode !== 0) {
      throw new Error(`Build exited with ${exitCode}: ${await stderr}`)
    }

    const outdir = join(fixture.root, ".sixb", "dist", "app")
    const builtHtml = await readFile(join(outdir, "index.html"), "utf-8")
    const builtManifest = JSON.parse(await readFile(join(outdir, "app.webmanifest"), "utf-8"))
    expect(builtHtml).toContain('href="/app.webmanifest"')
    expect(builtHtml).toContain('href="/favicon.svg"')
    expect(builtHtml).toContain('class="sixb-loading-shell"')
    // The shell paints in the theme chosen in the app, not the system's: dark chosen on a light
    // system must not flash white. Reproduce by dropping the theme script from withLoadingShell.
    const bootstrap = builtHtml.match(/<script[^>]*data-sixb-theme[^>]*>([^<]*)<\/script>/)?.[1]
    expect(bootstrap).toBeDefined()
    const themeClasses = (stored: string | null, systemDark: boolean) => {
      const classes: string[] = []
      new Function("localStorage", "matchMedia", "document", bootstrap ?? "")(
        { getItem: (key: string) => (key === "sixb-theme" ? stored : null) },
        () => ({ matches: systemDark }),
        { documentElement: { classList: { add: (name: string) => classes.push(name) } } }
      )
      return classes
    }
    expect(themeClasses("dark", false)).toEqual(["dark"])
    expect(themeClasses("light", true)).toEqual(["light"])
    // With no choice stored the app's own theme decides: an app without a ThemeProvider is light
    // on a dark system. Reproduce by having the script add `dark` for the system's preference.
    expect(themeClasses(null, true)).toEqual([])
    expect(themeClasses("system", true)).toEqual([])
    expect(builtHtml).not.toContain("main.tsx")
    const scriptFile = builtHtml.match(/src="\/(app-[a-z0-9]+\.js)"/)?.[1]
    expect(scriptFile).toBeDefined()
    expect(await Bun.file(join(outdir, `${scriptFile}.br`)).exists()).toBe(true)
    expect(await Bun.file(join(outdir, `${scriptFile}.gz`)).exists()).toBe(true)
    expect(builtManifest.name).toBe("Built PWA")
    expect(builtManifest.icons[0].src).toBe("/icon-192.png")
    expect(await readFile(join(outdir, "icon-192.png"), "utf-8")).toBe("fixture png")
  }, 30_000)

  // Regression proof: drop `!options.projectPages` from defaultShell in codegen and the second
  // runtime wraps the project's own pages in AppShell.
  test("only a project with no app/ pages or layout gets the default shell", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    const runtime = async (projectPages: boolean) => {
      const { runtimePath } = await generateAppEntry(fixture.root, fixture.generatedDir, {
        sections: true,
        projectPages,
      })
      return readFile(runtimePath, "utf-8")
    }

    expect(await runtime(false)).toContain("<AppShell>")
    // Pages without a layout rendered bare before the built-in pages, and still do.
    expect(await runtime(true)).not.toContain("<AppShell>")
  })
})
