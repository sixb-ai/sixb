#!/usr/bin/env bun

import { scaffoldProject } from "./scaffold"

const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun create sixb <project-name>")
  process.exit(0)
}

if (args.length !== 1 || args[0]?.startsWith("-")) {
  console.error("[create-sixb] A project name is required.")
  console.error("Usage: bun create sixb <project-name>")
  process.exit(1)
}

try {
  const result = await scaffoldProject(args[0]!)
  console.log(`Created ${result.name} in ${result.targetDir}`)
  console.log(`\nNext steps:\n  cd ${result.name}\n  bun install\n  bun run dev`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[create-sixb] ${message}`)
  process.exit(1)
}
