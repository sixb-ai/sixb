#!/usr/bin/env bun
/**
 * Build the canonical sixb agent sandbox image archive.
 *
 *   bun run build-agent-image.ts                          # host arch -> shared cache
 *   bun run build-agent-image.ts --platform linux/amd64   # cross-build (e.g. for x86_64 droplets)
 *   bun run build-agent-image.ts --out ./agent.tar        # explicit output path
 *
 * Requires Docker or Podman (build host only — the machine that runs the sandbox
 * needs just smolvm + the archive). One-time; every run after reads the cache.
 */
import { buildAgentImage } from "../src/agent-image"

let platform: string | undefined
let output: string | undefined
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === "--platform" || arg === "-p") platform = args[++i]
  else if (arg === "--out" || arg === "-o") output = args[++i]
  else if (!arg.startsWith("-")) output = arg
}

const path = await buildAgentImage({ platform, output })
console.log(`\nBuilt agent image -> ${path}`)
