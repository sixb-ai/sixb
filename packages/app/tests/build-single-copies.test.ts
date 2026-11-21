import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const pluginPath = resolve(import.meta.dir, "..", "src", "build-single-copies.ts")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// A project with its own `prosemirror-view` beside the one the app's `@tiptap/pm` loads, as a
// project pinning another TipTap version installs. Reproduce: build with `plugins: []` and the
// bundle holds both copies, printing `false top`.
test("the browser bundle loads the app's copy of ProseMirror for every importer", async () => {
  const root = await mkdtemp(join(tmpdir(), "sixb-single-copies-"))
  roots.push(root)
  const app = join(root, "app")
  await writePackage(join(root, "node_modules", "prosemirror-view"), "top")
  await writeFiles(join(app, "node_modules", "@tiptap", "pm"), {
    "package.json": JSON.stringify({
      name: "@tiptap/pm",
      type: "module",
      exports: { "./view": "./dist/view/index.js" },
    }),
    "dist/view/index.js": `export * from "prosemirror-view"\n`,
  })
  await writePackage(
    join(app, "node_modules", "@tiptap", "pm", "node_modules", "prosemirror-view"),
    "app"
  )
  await writeFiles(root, {
    "app/editor.js": `export { DecorationSet as appCopy } from "@tiptap/pm/view"\n`,
    "entry.js": [
      `import { DecorationSet } from "prosemirror-view"`,
      `import { appCopy } from "./app/editor.js"`,
      `console.log(DecorationSet === appCopy, DecorationSet.copy)`,
    ].join("\n"),
    "build.ts": [
      `import { singleCopyPlugin } from ${JSON.stringify(pluginPath)}`,
      `const result = await Bun.build({`,
      `  entrypoints: [${JSON.stringify(join(root, "entry.js"))}],`,
      `  outdir: ${JSON.stringify(join(root, "out"))},`,
      `  target: "browser",`,
      `  plugins: [singleCopyPlugin(${JSON.stringify(app)})],`,
      `  throw: false,`,
      `})`,
      `if (!result.success) throw new Error(result.logs.map(String).join("\\n"))`,
    ].join("\n"),
  })

  const build = await runBun(["run", join(root, "build.ts")], root)
  expect(build.exitCode, build.stderr).toBe(0)

  const run = await runBun(["run", join(root, "out", "entry.js")], root)
  expect(run.exitCode, run.stderr).toBe(0)
  expect(run.stdout.trim()).toBe("true app")
})

async function writePackage(dir: string, copy: string): Promise<void> {
  await writeFiles(dir, {
    "package.json": JSON.stringify({ name: "prosemirror-view", type: "module", main: "index.js" }),
    "index.js": `export class DecorationSet { static copy = ${JSON.stringify(copy)} }\n`,
  })
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
}

async function runBun(
  args: string[],
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 15_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timer)
  return { exitCode, stdout, stderr }
}
