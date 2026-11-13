// Reads what the render worker's scripts wrote, in a sandbox, a piece at a time: each piece is a
// path, where it starts, and how many bytes. One line of JSON per piece, in order: { data } with
// those bytes in base64, or { error } when the file cannot be read.
//
//   node read.cjs <path> <start> <length> [<path> <start> <length>]...

const fs = require("node:fs")

const args = process.argv.slice(2)
for (let at = 0; at + 2 < args.length; at += 3) {
  let line
  try {
    const length = Number(args[at + 2])
    const buffer = Buffer.alloc(length)
    const file = fs.openSync(args[at], "r")
    try {
      const read = fs.readSync(file, buffer, 0, length, Number(args[at + 1]))
      line = { data: buffer.subarray(0, read).toString("base64") }
    } finally {
      fs.closeSync(file)
    }
  } catch {
    line = { error: "unreadable" }
  }
  process.stdout.write(`${JSON.stringify(line)}\n`)
}
