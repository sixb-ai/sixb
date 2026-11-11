import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const entrypoint = resolve(packageRoot, "src", "tools", "search", "main.ts")
const outputPath = resolve(packageRoot, "src", "generated", "search.mjs")
const check = process.argv.includes("--check")
// The bundle's path comments are relative to the working directory: build from the package's, so
// the bundle is the same wherever the script is run from.
process.chdir(packageRoot)

const result = await Bun.build({
  entrypoints: [entrypoint],
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error("[SixbAgent] Failed to generate the search script.")
}

const artifact = result.outputs.find((output) => output.kind === "entry-point")
if (!artifact) throw new Error("[SixbAgent] The build produced no search script.")
const generated = await artifact.text()

if (check) {
  let committed = ""
  try {
    committed = await readFile(outputPath, "utf8")
  } catch {}
  if (committed !== generated) {
    throw new Error(
      "[SixbAgent] The generated search script is stale. Run `bun run generate:search-script`."
    )
  }
  console.log("[SixbAgent] Generated search script is current.")
} else {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, generated)
  console.log(`[SixbAgent] Generated ${outputPath}`)
}
