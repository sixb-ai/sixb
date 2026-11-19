import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { HYPERFRAMES_VERSION } from "../src/artifacts/frames/hyperframes"

// Copies the HyperFrames runtime a video's frame plays with, `@hyperframes/core`'s
// `hyperframe.runtime.iife.js`, from the exact version this package's devDependencies pin. It is
// committed, as the frame route serves it from source, and CI copies it again to check it is
// current: `bun run generate:hyperframes-runtime`. Only the runtime ships: the package's own
// dependencies weigh 60 MB, which a project that plays a video has no use for. It is kept as
// `.txt`, which every Bun loader reads as text.

const packageRoot = resolve(import.meta.dir, "..")
const outputPath = resolve(packageRoot, "src/artifacts/frames/generated/hyperframes.txt")
const check = process.argv.includes("--check")

const require = createRequire(resolve(packageRoot, "package.json"))
const { version } = require("@hyperframes/core/package.json") as { version: string }
if (version !== HYPERFRAMES_VERSION) {
  throw new Error(
    `[Sixb] @hyperframes/core is ${version}, but HYPERFRAMES_VERSION says ${HYPERFRAMES_VERSION}. Pin both, and the agent image's CLI, to one release.`
  )
}

const runtime = await readFile(require.resolve("@hyperframes/core/runtime"), "utf8")
const generated = `/*! HyperFrames runtime ${version}, from @hyperframes/core (Apache-2.0): https://github.com/heygen-com/hyperframes */\n${runtime}`

if (check) {
  const committed = await readFile(outputPath, "utf8").catch(() => "")
  if (committed !== generated) {
    throw new Error(
      "[Sixb] The HyperFrames runtime is stale. Run `bun run generate:hyperframes-runtime`."
    )
  }
  console.log("[Sixb] The HyperFrames runtime is current.")
} else {
  await writeFile(outputPath, generated)
  console.log(`[Sixb] Generated ${outputPath} (${Math.round(generated.length / 1024)} KB)`)
}
