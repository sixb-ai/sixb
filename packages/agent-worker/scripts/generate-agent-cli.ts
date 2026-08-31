import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const entrypoint = resolve(packageRoot, "src", "agent-cli", "index.ts")
const outputPath = resolve(packageRoot, "src", "agent-cli", "generated", "sixb.mjs")
const check = process.argv.includes("--check")

const result = await Bun.build({
  entrypoints: [entrypoint],
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error("[SixbAgentCli] Failed to generate the portable CLI artifact.")
}

const artifact = result.outputs.find((output) => output.kind === "entry-point")
if (!artifact) throw new Error("[SixbAgentCli] The build produced no CLI entry point.")
const generated = await artifact.text()

if (check) {
  let committed = ""
  try {
    committed = await readFile(outputPath, "utf8")
  } catch {}
  if (committed !== generated) {
    throw new Error("[SixbAgentCli] The generated CLI is stale. Run `bun run generate:agent-cli`.")
  }
  console.log("[SixbAgentCli] Generated CLI is current.")
} else {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, generated)
  console.log(`[SixbAgentCli] Generated ${outputPath}`)
}
