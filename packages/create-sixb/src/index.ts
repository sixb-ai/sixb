#!/usr/bin/env bun

import { runCreate } from "@sixb/cli/create"

const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun create sixb <project-name>")
  process.exit(0)
}

const name = args.find((arg) => !arg.startsWith("-"))

if (!name) {
  console.error("[create-sixb] A project name is required.")
  console.error("Usage: bun create sixb <project-name>")
  process.exit(1)
}

try {
  await runCreate(name)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[create-sixb] ${message}`)
  process.exit(1)
}
