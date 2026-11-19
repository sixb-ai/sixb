import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxFileRecord } from "@sixb/core"
import { exec } from "@sixb/core/sandboxes"
import { buildWriteFilesInput, WRITE_FILES_SCRIPT } from "../src/smolvm-sandbox"

// The script runs on this host's `sh` and `dd`, as the guest's would run it: GNU, BusyBox and BSD
// `dd` all take the flags it uses.

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sixb-smolvm-write-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function write(input: Blob) {
  return exec({
    argv: ["/bin/sh", "-c", WRITE_FILES_SCRIPT],
    cwd: "/",
    env: { PATH: process.env.PATH ?? "" },
    stdin: input,
    timeoutMs: 10_000,
  })
}

test("writes each path and its exact bytes, whatever they hold", async () => {
  // Past one 64 KiB block, so both of the script's copies run for one file.
  const binary = Uint8Array.from({ length: 2 * 65536 + 5 }, (_, index) => index % 251)
  const files: SandboxFileRecord[] = [
    { path: join(directory, "it's $(touch pwned).txt"), contents: "quoted" },
    { path: join(directory, "line\nbreak", "trailing\n"), contents: "newlines" },
    { path: join(directory, " spaced "), contents: "end\n1 1 -\n/x" },
    { path: join(directory, "nested", "deep", "empty"), contents: "" },
    { path: join(directory, "binary.bin"), contents: binary },
  ]

  const result = await write(buildWriteFilesInput(files))

  expect(result).toMatchObject({ exitCode: 0, stderr: "" })
  for (const file of files) {
    expect(await readFile(file.path)).toEqual(Buffer.from(file.contents))
  }
  expect((await readdir(directory)).sort()).toEqual(
    [" spaced ", "binary.bin", "it's $(touch pwned).txt", "line\nbreak", "nested"].sort()
  )
})

test("applies a mode only when one is set", async () => {
  const executable = join(directory, "run.sh")
  const plain = join(directory, "plain.txt")

  const result = await write(
    buildWriteFilesInput([
      { path: executable, contents: "#!/bin/sh\n", mode: 0o750 },
      { path: plain, contents: "x" },
    ])
  )

  expect(result.exitCode).toBe(0)
  expect((await stat(executable)).mode & 0o777).toBe(0o750)
  expect((await stat(plain)).mode & 0o111).toBe(0)
})

// Regression check: let the script exit 0 when its input runs out; the cut file is then kept and
// the write reports success.
test("an input cut short fails rather than leave a truncated file", async () => {
  const input = buildWriteFilesInput([{ path: join(directory, "cut.txt"), contents: "complete" }])

  const result = await write(input.slice(0, input.size - "end\n".length - 3))

  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain("the files' input ended early")
})
