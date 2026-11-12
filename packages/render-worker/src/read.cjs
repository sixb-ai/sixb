// Reads files the render worker's scripts wrote, in a sandbox, for the worker to keep: one line of
// JSON per path, in order, { data } with the file in base64, or { error } when it is past
// <most bytes> or cannot be read.
//
//   node read.cjs <most bytes> <path>...

const fs = require("node:fs")

const [most, ...paths] = process.argv.slice(2)
const MAX_BYTES = Number(most) || 8 * 1024 * 1024

for (const file of paths) {
  let line
  try {
    const { size } = fs.statSync(file)
    line = size > MAX_BYTES ? { error: "too_large" } : { data: fs.readFileSync(file).toString("base64") }
  } catch {
    line = { error: "unreadable" }
  }
  process.stdout.write(`${JSON.stringify(line)}\n`)
}
