#!/usr/bin/env bun

import { formatCreateSuccess } from "./output"
import { scaffoldProject } from "./scaffold"

const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log("create-sixb")
  console.log("Create a new Sixb project")
  console.log("\nUsage\n  bun create sixb <directory>")
  process.exit(0)
}

if (args.length !== 1 || args[0]?.startsWith("-")) {
  console.error("[create-sixb] Expected exactly one project directory.")
  console.error("Usage: bun create sixb <directory>")
  process.exit(1)
}

try {
  const result = await scaffoldProject(args[0]!)
  console.log(formatCreateSuccess(result))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[create-sixb] ${message}`)
  process.exit(1)
}
