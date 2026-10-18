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
  // Resolved as this package resolves them.
  const appRoot = resolve(import.meta.dir, "..")
  const rokuRoot = resolve(import.meta.dir, "..", "..", "..", "examples", "roku-tv")

  for (const name of packages) {
    let packageDir: string
    try {
      packageDir = dirname(Bun.resolveSync(`${name}/package.json`, appRoot))
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
  test.each([
    ["plain handwritten CSS", ":root { --bg: #000; }\nbody { margin: 0; }", false],
    ["a url import", '@import url("https://fonts.googleapis.com/css2?family=Sora");', false],
    ["a relative import", '@import "./tokens.css";', false],
    ["@source", '@source "./**/*.{ts,tsx}";', true],
    ["@theme", "@theme { --color-brand: #fff; }", true],
    ["@apply", ".btn { @apply rounded; }", true],
    ["a bare tailwindcss import", '@import "tailwindcss";', true],
    ["a bare package stylesheet import", '@import "@sixb/ui/globals.css";', true],
    ["directives inside comments", '/* @import "tailwindcss"; @source "./x"; */ body {}', false],
  ])("%s → Tailwind source: %p", (_label, css, expected) => {
    expect(usesTailwind(css)).toBe(expected)
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

    const error = await resolveCustomAppStylesheet({
      appDir: join(tempRoot, "app"),
      generatedDir: join(tempRoot, ".sixb", "generated"),
      rootDir: tempRoot,
    }).catch((caught) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("@tailwindcss/cli")
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

describe("custom app Tailwind dev server", () => {
  // Inside the repo so the generated entry's react/react-router imports and
  // the Tailwind CLI resolve from the workspace's node_modules.
  // The production build of this fixture runs in build-browser.e2e.ts.
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

  test("dev watches app sources and recompiles Tailwind CSS in-process", async () => {
    const app = await createCustomApp({ rootDir: tempRoot, apiBaseUrl: "http://127.0.0.1:3000" })
    // Nothing is fetched, so the server may bind any free port.
    const server = await app.dev({ host: "127.0.0.1", port: 0 })
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
        if (attempts % 80 === 0) {
          // macOS fsevents can drop the first event on a freshly created
          // recursive watch; re-touching the file re-triggers it.
          await writeFile(join(tempRoot, "app", "page.tsx"), updatedPage)
        }
        // Reading the file is cheap; a short poll ends soon after the rebuild lands.
        await Bun.sleep(25)
      }
      expect(css).toContain(watchedUtility)
    } finally {
      await server.stop()
    }
  }, 30_000)
})

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
