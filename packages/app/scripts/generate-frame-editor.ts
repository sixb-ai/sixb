import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

// Builds the designed document editor's script, which the app sends a document's frame to run
// there (`src/artifacts/frame-editor`). It is committed, as the app imports it as text, and CI
// builds it again to check it is current: `bun run generate:frame-editor`. It is kept as `.txt`,
// which every Bun loader reads as text, the dev server's among them: it ignores `type: "text"`
// on a `.js` file and runs it instead.

const packageRoot = resolve(import.meta.dir, "..")
const entrypoint = resolve(packageRoot, "src/artifacts/frame-editor/entry.ts")
const outputPath = resolve(packageRoot, "src/artifacts/frame-editor/generated/editor.txt")
const check = process.argv.includes("--check")
process.chdir(packageRoot)

const result = await Bun.build({
  entrypoints: [entrypoint],
  target: "browser",
  format: "iife",
  // FRAME_EDITOR_DEBUG=1 builds it readable, for a stack trace from the frame.
  minify: !process.env.FRAME_EDITOR_DEBUG,
  sourcemap: "none",
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error("[SixbApp] Failed to build the frame editor.")
}

const artifact = result.outputs.find((output) => output.kind === "entry-point")
if (!artifact) throw new Error("[SixbApp] The build produced no frame editor.")
const generated = await artifact.text()

if (check) {
  let committed = ""
  try {
    committed = await readFile(outputPath, "utf8")
  } catch {}
  if (committed !== generated) {
    throw new Error("[SixbApp] The frame editor is stale. Run `bun run generate:frame-editor`.")
  }
  console.log("[SixbApp] The frame editor is current.")
} else {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, generated)
  console.log(`[SixbApp] Generated ${outputPath} (${Math.round(generated.length / 1024)} KB)`)
}
