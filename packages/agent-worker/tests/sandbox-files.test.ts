import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  listSandboxFiles,
  readSandboxFile,
  resolveSandboxPath,
  SandboxFileError,
} from "../src/sandbox-files"
import { LocalBashSandbox } from "./helpers"

// The scripts run in a real local bash against a temporary directory, so the symlink, escape, and
// size checks are exercised as a sandbox would run them.

let root: string
let outside: string

beforeEach(() => {
  // realpath: on macOS the temporary directory sits behind the /var → /private/var symlink, and
  // the read script compares physical paths.
  root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-sandbox-files-")))
  outside = realpathSync(mkdtempSync(join(tmpdir(), "sixb-sandbox-outside-")))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const signal = new AbortController().signal
const handle = () => ({ sandbox: new LocalBashSandbox(root) })

describe("resolveSandboxPath", () => {
  test("resolves relative and absolute paths inside the working directory", () => {
    expect(resolveSandboxPath("/workspace", "out/report.md")).toBe("/workspace/out/report.md")
    expect(resolveSandboxPath("/workspace/", "/workspace/a/../b.txt")).toBe("/workspace/b.txt")
  })

  test("rejects empty paths, the directory itself, and paths that leave it", () => {
    for (const [path, reason] of [
      ["", "invalid_path"],
      ["a\0b", "invalid_path"],
      [".", "outside_root"],
      ["../etc/passwd", "outside_root"],
      ["/etc/passwd", "outside_root"],
      ["/workspace-other/file", "outside_root"],
    ] as const) {
      expect(() => resolveSandboxPath("/workspace", path), path).toThrow(
        expect.objectContaining({ reason })
      )
    }
  })
})

describe("listSandboxFiles", () => {
  test("lists regular files with their sizes, sorted, and never symbolic links", async () => {
    mkdirSync(join(root, "out", "figures"), { recursive: true })
    writeFileSync(join(root, "out", "report.md"), "# Report")
    writeFileSync(join(root, "out", "figures", "chart one.svg"), "<svg/>")
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(join(outside, "secret.txt"), join(root, "out", "linked.txt"))

    const listing = await listSandboxFiles(handle(), {
      directory: join(root, "out"),
      maxFiles: 10,
      signal,
      timeoutMs: 10_000,
    })

    expect(listing).toEqual({
      directory: true,
      files: [
        { relativePath: "figures/chart one.svg", sizeBytes: 6 },
        { relativePath: "report.md", sizeBytes: 8 },
      ],
      truncated: false,
    })
  })

  test("refuses output it cannot parse rather than leave a file out", async () => {
    // Reproduce by skipping the line: the listing succeeds without the file.
    const sandbox = new LocalBashSandbox(root)
    sandbox.runCommand = async () => ({
      exitCode: 0,
      stdout: `DIRECTORY\n8\t${Buffer.from("report.md").toString("base64")}\nsize?\tZmlndXJlLnN2Zw==\n`,
      stderr: "",
      durationMs: 1,
    })
    await expect(
      listSandboxFiles({ sandbox }, { directory: root, maxFiles: 10, signal, timeoutMs: 10_000 })
    ).rejects.toMatchObject({ reason: "failed" })
  })

  test("stops at the file limit and says so", async () => {
    mkdirSync(join(root, "out"))
    for (const name of ["a", "b", "c"]) writeFileSync(join(root, "out", name), name)

    const listing = await listSandboxFiles(handle(), {
      directory: join(root, "out"),
      maxFiles: 2,
      signal,
      timeoutMs: 10_000,
    })

    expect(listing.files).toHaveLength(2)
    expect(listing.truncated).toBe(true)
  })
})

describe("readSandboxFile", () => {
  const read = (path: string, maxBytes = 1024) =>
    readSandboxFile(handle(), { path, maxBytes, signal, timeoutMs: 10_000 })

  test("returns a regular file's bytes, and refuses missing files and symbolic links", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    writeFileSync(join(root, "data.bin"), bytes)
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"))

    expect(await read(join(root, "data.bin"))).toEqual(bytes)
    await expect(read(join(root, "missing.txt"))).rejects.toMatchObject({ reason: "not_found" })
    await expect(read(join(root, "link.txt"))).rejects.toMatchObject({ reason: "not_found" })
  })

  test("refuses a file whose parent directory resolves outside the working directory", async () => {
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(outside, join(root, "escape"))

    await expect(read(join(root, "escape", "secret.txt"))).rejects.toMatchObject({
      reason: "outside_root",
    })
  })

  test("refuses a file over the byte limit", async () => {
    writeFileSync(join(root, "large.txt"), "12345")
    const error = await read(join(root, "large.txt"), 4).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SandboxFileError)
    expect(error).toMatchObject({
      reason: "too_large",
      message: "file exceeds the 4-byte limit",
    })
  })
})

/** Runs each command in a local bash, without a login shell, in the given working directory. */
