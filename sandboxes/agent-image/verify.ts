#!/usr/bin/env bun
import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

const version = (await readFile(resolve(import.meta.dir, "VERSION"), "utf8")).trim()
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    image: { type: "string", default: `sixb-agent:${version}` },
    output: { type: "string", default: ".local/agent-image/verification" },
  },
})
const output = resolve(values.output)
await mkdir(output, { recursive: true })
const name = `sixb-image-check-${crypto.randomUUID()}`

async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    timeout: 300_000,
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`[SixbImage] docker ${args[0]} failed (${code})`)
}

let created = false
try {
  // Run as an arbitrary unprivileged UID with networking disabled: providers do not all run
  // commands as the same user, and success cannot depend on a package download. The provider
  // supplies HOME; uv keeps its cache there. Checks are mounted, not shipped in the image.
  await docker([
    "create",
    "--name",
    name,
    "--network",
    "none",
    "--user",
    "4242:4242",
    "--env",
    "HOME=/tmp",
    "--volume",
    `${resolve(import.meta.dir, "tests")}:/checks:ro`,
    values.image,
    "python3",
    "/checks/smoke.py",
    "/workspace/qa",
  ])
  created = true
  await docker(["start", "--attach", name])
  // Preserve artifacts for visual inspection.
  await docker(["cp", `${name}:/workspace/qa`, output])
  console.log(`[SixbImage] Verification artifacts: ${output}/qa`)
} finally {
  if (created) await docker(["rm", "--force", name])
}
