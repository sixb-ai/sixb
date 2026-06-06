import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const inputPath = join(import.meta.dir, "styles.css")
const outputPath = join(import.meta.dir, "..", ".docs", "styles.css")

await mkdir(dirname(outputPath), { recursive: true })

const args = [process.execPath, await resolveTailwindCliEntry(), "-i", inputPath, "-o", outputPath]

if (process.env.NODE_ENV === "production") {
  args.push("--minify")
}

const proc = Bun.spawn(args, {
  cwd: join(import.meta.dir, ".."),
  stdout: "ignore",
  stderr: "pipe",
})

const exitCode = await proc.exited

if (exitCode !== 0) {
  const stderr = await new Response(proc.stderr).text()
  throw new Error(`[SixbDocs] Failed to build CSS: ${stderr.trim()}`)
}

async function resolveTailwindCliEntry(): Promise<string> {
  return join(
    dirname(fileURLToPath(import.meta.resolve("@tailwindcss/cli/package.json"))),
    "dist",
    "index.mjs"
  )
}
