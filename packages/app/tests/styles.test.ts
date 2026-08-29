import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createCustomApp } from "../src/createCustomApp"
import { resolveCustomAppStylesheet, usesTailwind } from "../src/styles"
import { createTailwindCssCompiler } from "../src/tailwind"

// Links already-installed workspace packages into a fixture project's
// node_modules, the way a real app would have them installed.
async function linkDepsInto(projectRoot: string, packages: readonly string[]): Promise<void> {
  const atlasRoot = resolve(import.meta.dir, "..", "..", "atlas")
  const rokuRoot = resolve(import.meta.dir, "..", "..", "..", "examples", "roku-tv")

  for (const name of packages) {
    let packageDir: string
    try {
      packageDir = dirname(Bun.resolveSync(`${name}/package.json`, atlasRoot))
    } catch {
      packageDir = dirname(Bun.resolveSync(`${name}/package.json`, rokuRoot))
    }

    const target = join(projectRoot, "node_modules", ...name.split("/"))
    await mkdir(dirname(target), { recursive: true })
    await symlink(packageDir, target)
  }
}

const TAILWIND_PACKAGES = ["@tailwindcss/cli", "tailwindcss"] as const

describe("usesTailwind", () => {
  test("plain handwritten CSS is not Tailwind source", () => {
    expect(usesTailwind(":root { --bg: #000; }\nbody { margin: 0; }")).toBe(false)
  })

  test("url and relative imports are not Tailwind source", () => {
    expect(usesTailwind('@import url("https://fonts.googleapis.com/css2?family=Sora");')).toBe(
      false
    )
    expect(usesTailwind('@import "./tokens.css";')).toBe(false)
  })

  test("Tailwind at-rules mark the file as source", () => {
    expect(usesTailwind('@source "./**/*.{ts,tsx}";')).toBe(true)
    expect(usesTailwind("@theme { --color-brand: #fff; }")).toBe(true)
    expect(usesTailwind(".btn { @apply rounded; }")).toBe(true)
  })

  test("bare-specifier imports mark the file as source", () => {
    expect(usesTailwind('@import "tailwindcss";')).toBe(true)
    expect(usesTailwind('@import "@sixb/ui/globals.css";')).toBe(true)
  })

  test("directives inside comments are ignored", () => {
    expect(usesTailwind('/* @import "tailwindcss"; @source "./x"; */ body {}')).toBe(false)
  })
})

describe("resolveCustomAppStylesheet", () => {
  let tempRoot = ""

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sixb-app-styles-"))
    await mkdir(join(tempRoot, "app"), { recursive: true })
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test("returns none when app/globals.css does not exist", async () => {
    const stylesheet = await resolveCustomAppStylesheet({
      appDir: join(tempRoot, "app"),
      generatedDir: join(tempRoot, ".sixb", "generated"),
      rootDir: tempRoot,
    })
    expect(stylesheet).toEqual({ kind: "none" })
  })

  test("plain CSS keeps the pass-through path", async () => {
    const globalsPath = join(tempRoot, "app", "globals.css")
    await writeFile(globalsPath, "body { margin: 0; }\n")

    const stylesheet = await resolveCustomAppStylesheet({
      appDir: join(tempRoot, "app"),
      generatedDir: join(tempRoot, ".sixb", "generated"),
      rootDir: tempRoot,
    })
    expect(stylesheet).toEqual({ kind: "static", path: globalsPath })
  })

  test("Tailwind source without an installed CLI fails with an actionable error", async () => {
    await writeFile(join(tempRoot, "app", "globals.css"), '@import "tailwindcss";\n')

    expect(
      resolveCustomAppStylesheet({
        appDir: join(tempRoot, "app"),
        generatedDir: join(tempRoot, ".sixb", "generated"),
        rootDir: tempRoot,
      })
    ).rejects.toThrow("@tailwindcss/cli")
  })

  test("Tailwind source compiles to the generated dir when the CLI is resolvable", async () => {
    await writeFile(join(tempRoot, "app", "globals.css"), '@source "./**/*.tsx";\n')
    await linkDepsInto(tempRoot, TAILWIND_PACKAGES)

    const stylesheet = await resolveCustomAppStylesheet({
      appDir: join(tempRoot, "app"),
      generatedDir: join(tempRoot, ".sixb", "generated"),
      rootDir: tempRoot,
    })
    expect(stylesheet).toEqual({
      kind: "tailwind",
      sourcePath: join(tempRoot, "app", "globals.css"),
      outputPath: join(tempRoot, ".sixb", "generated", "app.css"),
    })
  })
})

describe("createTailwindCssCompiler", () => {
  let tempRoot = ""

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sixb-tailwind-compiler-"))
    await installFakeTailwindCli(tempRoot)
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test("scheduled rebuilds work after a stopped compiler is compiled again", async () => {
    const inputPath = join(tempRoot, "app.css")
    const outputPath = join(tempRoot, "dist", "app.css")
    await writeFile(inputPath, ".initial { color: red; }\n")

    const compiler = createTailwindCssCompiler({
      inputPath,
      outputPath,
      cwd: tempRoot,
      resolveFrom: tempRoot,
      debounceMs: 1,
      label: "[SixbTest]",
    })

    try {
      await compiler.compile()
      expect(await readFile(outputPath, "utf-8")).toContain("initial")

      await compiler.stop()
      await writeFile(inputPath, ".after-restart { color: green; }\n")
      await compiler.compile()
      expect(await readFile(outputPath, "utf-8")).toContain("after-restart")

      await writeFile(inputPath, ".scheduled { color: blue; }\n")
      compiler.schedule()
      await expectFileToContain(outputPath, "scheduled")
    } finally {
      await compiler.stop()
    }
  })
})

describe("custom app Tailwind build (e2e)", () => {
  // Inside the repo so the generated entry's react/react-router imports and
  // the Tailwind CLI resolve from the workspace's node_modules.
  let tempRoot = ""

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(import.meta.dir, "tmp-tailwind-e2e-"))
    await linkDepsInto(tempRoot, [
      ...TAILWIND_PACKAGES,
      "react",
      "react-dom",
      "react-router-dom",
      "@tanstack/react-query",
      "@sixb/app",
      "@sixb/client",
      "@sixb/agent-ui",
      "@sixb/ui",
    ])
    const appDir = join(tempRoot, "app")
    await mkdir(appDir, { recursive: true })
    await writeFile(
      join(appDir, "globals.css"),
      [
        '@import "@sixb/ui/globals.css";',
        '@source "./**/*.tsx";',
        ":root { --background: #123456; }",
        "",
      ].join("\n")
    )
    await writeFile(
      join(appDir, "page.tsx"),
      'export default function Page() { return <main className="line-through">ok</main> }\n'
    )
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test("sixb-style build compiles Tailwind CSS fresh and bundles it", async () => {
    // A leftover chunk from a previous build must not survive: the outdir is
    // build-owned and gets cleared, or stale hashed assets accumulate forever.
    const staleChunkPath = join(tempRoot, ".sixb", "dist", "app", "chunk-stale123.js")
    await mkdir(dirname(staleChunkPath), { recursive: true })
    await writeFile(staleChunkPath, "console.log('stale')\n")

    // Build in a subprocess like the real `sixb build` CLI. An in-process
    // Bun.build would also leak bundler state that breaks later dev-server
    // bundling tests in the same bun:test process.
    const buildScript = join(tempRoot, "run-build.ts")
    const createCustomAppPath = resolve(import.meta.dir, "..", "src", "createCustomApp.ts")
    await writeFile(
      buildScript,
      [
        `import { createCustomApp } from ${JSON.stringify(createCustomAppPath)}`,
        `const app = await createCustomApp({ rootDir: ${JSON.stringify(tempRoot)}, apiBaseUrl: "http://127.0.0.1:3000" })`,
        "const result = await app.build()",
        "if (!result.success) throw new Error((result.logs ?? []).join('\\n'))",
        "",
      ].join("\n")
    )
    const proc = Bun.spawn([process.execPath, "run", buildScript], {
      cwd: tempRoot,
      stdout: "ignore",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(await new Response(proc.stderr).text())
    }

    // The compiled stylesheet lands under .sixb/generated, not app/.
    // Canary classes, one per scanned source — proves Tailwind compiled the app's own page plus the
    // linked component libraries, not just one of them. `line-through` is the app page, `max-h-60`
    // comes only from @sixb/agent-ui, `h-dvh` only from @sixb/app. (Repoint these if a class is
    // removed from its source rather than asserting a class that no longer exists.)
    const generatedCss = await readFile(join(tempRoot, ".sixb", "generated", "app.css"), "utf-8")
    expect(generatedCss).toContain("line-through")
    expect(generatedCss).toContain("max-h-60")
    expect(generatedCss).toContain("h-dvh")
    expect(generatedCss.lastIndexOf("--background: #123456")).toBeGreaterThan(
      generatedCss.lastIndexOf("--background: #fafafa")
    )

    const generatedRuntime = await readFile(
      join(tempRoot, ".sixb", "generated", "app-runtime.tsx"),
      "utf-8"
    )
    expect(generatedRuntime).toContain('import "./app.css"')
    expect(generatedRuntime).not.toContain('import "./agent-ui.css"')

    // The bundled output ships the compiled utility, proving the generated
    // entry imported the compiled CSS rather than the raw Tailwind source.
    const outdir = join(tempRoot, ".sixb", "dist", "app")
    const cssBundles: string[] = []
    for await (const path of new Bun.Glob("*.css").scan({ cwd: outdir, absolute: true })) {
      cssBundles.push(await readFile(path, "utf-8"))
    }
    expect(cssBundles.join("\n")).toContain("line-through")
    expect(cssBundles.join("\n")).not.toContain("@source")

    const builtHtml = await readFile(join(outdir, "index.html"), "utf-8")
    const entryFile = builtHtml.match(/src="\/(app-[a-z0-9]+\.js)"/)?.[1]
    expect(entryFile).toBeDefined()
    const sharedHtml = await readFile(join(outdir, "shared-index.html"), "utf-8")
    expect(sharedHtml).toContain("async loadAppStyles()")
    expect(sharedHtml).toContain('link.addEventListener("load", resolve, { once: true })')
    expect(sharedHtml).toContain('link.addEventListener("error", resolve, { once: true })')
    expect(sharedHtml.indexOf("await Promise.all(")).toBeLessThan(
      sharedHtml.indexOf("document.head.append(link)")
    )
    const javascriptFiles = await Array.fromAsync(new Bun.Glob("*.js").scan({ cwd: outdir }))
    expect(javascriptFiles.length).toBeGreaterThan(1)
    const hasDynamicChunk = await Promise.all(
      javascriptFiles.map(async (file) =>
        (await readFile(join(outdir, file), "utf-8")).includes('import("/chunk-')
      )
    )
    expect(hasDynamicChunk).toContain(true)
    // Regression proof: restoring the HTML entry without `splitting` emits one ~10 MB JavaScript
    // file for this fixture (all Shiki grammars) and fails both assertions above.

    expect(await Bun.file(staleChunkPath).exists()).toBe(false)
  }, 30_000)

  test("dev watches app sources and recompiles Tailwind CSS in-process", async () => {
    const app = await createCustomApp({ rootDir: tempRoot, apiBaseUrl: "http://127.0.0.1:3000" })
    const server = await app.dev({ host: "127.0.0.1", port: await getFreePort() })
    const generatedCssPath = join(tempRoot, ".sixb", "generated", "app.css")
    const watchedUtility = "--sixb-watch-sentinel"

    try {
      expect(await readFile(generatedCssPath, "utf-8")).not.toContain(watchedUtility)

      // A page edit introduces a new utility class; the framework's own
      // watcher must pick it up without any userland CSS watcher.
      const updatedPage =
        'export default function Page() { return <main className="line-through [--sixb-watch-sentinel:1]">ok</main> }\n'
      await writeFile(join(tempRoot, "app", "page.tsx"), updatedPage)

      const deadline = Date.now() + 10_000
      let css = ""
      let attempts = 0
      while (Date.now() < deadline) {
        css = await readFile(generatedCssPath, "utf-8")
        if (css.includes(watchedUtility)) break
        attempts++
        if (attempts % 20 === 0) {
          // macOS fsevents can drop the first event on a freshly created
          // recursive watch; re-touching the file re-triggers it.
          await writeFile(join(tempRoot, "app", "page.tsx"), updatedPage)
        }
        await Bun.sleep(100)
      }
      expect(css).toContain(watchedUtility)
    } finally {
      await server.stop()
    }
  }, 30_000)
})

async function getFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null) })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) {
    throw new Error("Could not resolve an open port")
  }
  return port
}

async function installFakeTailwindCli(projectRoot: string): Promise<void> {
  const cliRoot = join(projectRoot, "node_modules", "@tailwindcss", "cli")
  await mkdir(join(cliRoot, "dist"), { recursive: true })
  await writeFile(
    join(cliRoot, "package.json"),
    `${JSON.stringify({ name: "@tailwindcss/cli", type: "module" })}\n`
  )
  await writeFile(
    join(cliRoot, "dist", "index.mjs"),
    [
      'const input = process.argv[process.argv.indexOf("-i") + 1]',
      'const output = process.argv[process.argv.indexOf("-o") + 1]',
      "await Bun.write(output, await Bun.file(input).text())",
      "",
    ].join("\n")
  )
}

async function expectFileToContain(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000
  let content = ""

  while (Date.now() < deadline) {
    content = await readFile(path, "utf-8")
    if (content.includes(expected)) {
      expect(content).toContain(expected)
      return
    }
    await Bun.sleep(20)
  }

  expect(content).toContain(expected)
}
