import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  FilePolicyError,
  materializeBatch,
  parseManifest,
  workspaceIdentity,
} from "../src/guest/workspace-files"

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})
function fixture(contents: readonly (string | Uint8Array)[] = ["new content"]) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "sixb-azure-files-")))
  temporary.push(base)
  const workspace = path.join(base, "workspace")
  const staging = path.join(base, "staging")
  fs.mkdirSync(workspace)
  fs.mkdirSync(staging)
  contents.forEach((content, index) => {
    fs.writeFileSync(path.join(staging, String(index)), content)
  })
  const identity = workspaceIdentity(workspace)
  const publish = (files: Parameters<typeof materializeBatch>[1]) =>
    materializeBatch(identity, files, staging, { uid: process.getuid!(), gid: process.getgid!() })
  return { base, workspace, staging, identity, publish }
}

test("publishes exact UTF-8, binary subarrays and empty files with owned parent directories", () => {
  const bytes = new Uint8Array([99, 0, 255, 254, 10, 99]).subarray(1, 5)
  const { workspace, publish } = fixture(["héllo 雪\n", bytes, ""])
  publish([
    { path: "nested/a 'quoted.txt" },
    { path: "nested/binary", mode: 0o640 },
    { path: "empty", mode: 0o755 },
  ])
  expect(fs.readFileSync(path.join(workspace, "nested/a 'quoted.txt"), "utf8")).toBe("héllo 雪\n")
  expect([...fs.readFileSync(path.join(workspace, "nested/binary"))]).toEqual([...bytes])
  expect(fs.readFileSync(path.join(workspace, "empty")).length).toBe(0)
  expect(fs.statSync(path.join(workspace, "empty")).mode & 0o7777).toBe(0o755)
  expect(fs.statSync(path.join(workspace, "nested/binary")).mode & 0o7777).toBe(0o640)
  expect(fs.statSync(path.join(workspace, "nested")).uid).toBe(process.getuid!())
  expect(fs.statSync(path.join(workspace, "nested")).mode & 0o777).toBe(0o700)
})

test("overwrites atomically, preserving an omitted mode and honoring mode zero", () => {
  const { workspace, publish } = fixture(["replacement", ""])
  fs.writeFileSync(path.join(workspace, "target"), "old contents", { mode: 0o751 })
  publish([{ path: "target" }, { path: "empty", mode: 0 }])
  expect(fs.readFileSync(path.join(workspace, "target"), "utf8")).toBe("replacement")
  expect(fs.statSync(path.join(workspace, "target")).mode & 0o7777).toBe(0o751)
  expect(fs.statSync(path.join(workspace, "empty")).mode & 0o7777).toBe(0)
  expect(fs.readdirSync(workspace).some((entry) => entry.startsWith(".sixb-write-"))).toBe(false)
})

for (const location of ["leaf", "parent", "inside"]) {
  test(`rejects ${location} symlinks without modifying their targets`, () => {
    const { base, workspace, publish } = fixture()
    const outside = path.join(base, "outside")
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "sentinel"), "untouched")
    fs.writeFileSync(path.join(workspace, "inside"), "inside untouched")
    const destination =
      location === "parent"
        ? outside
        : location === "inside"
          ? path.join(workspace, "inside")
          : path.join(outside, "sentinel")
    fs.symlinkSync(destination, path.join(workspace, "link"))
    // Negative control: replace the ancestor lstat/isDirectory guard with stat,
    // allowing links to directories. The parent-symlink case must then fail.
    expect(() => publish([{ path: location === "parent" ? "link/sentinel" : "link" }])).toThrow(
      FilePolicyError
    )
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("untouched")
    expect(fs.readFileSync(path.join(workspace, "inside"), "utf8")).toBe("inside untouched")
  })
}

test("replaces hard-link entries without changing outside contents, mode, or ownership", () => {
  const { base, workspace, publish } = fixture()
  const outside = path.join(base, "outside")
  fs.writeFileSync(outside, "untouched", { mode: 0o600 })
  const before = fs.statSync(outside)
  fs.linkSync(outside, path.join(workspace, "linked"))
  publish([{ path: "linked", mode: 0o755 }])
  expect(fs.readFileSync(outside, "utf8")).toBe("untouched")
  expect(fs.statSync(outside).mode).toBe(before.mode)
  expect(fs.statSync(outside).uid).toBe(before.uid)
  expect(fs.readFileSync(path.join(workspace, "linked"), "utf8")).toBe("new content")
  expect(fs.statSync(path.join(workspace, "linked")).ino).not.toBe(before.ino)
})

test("rejects a replaced workspace even at the same canonical path", () => {
  const { base, workspace, publish } = fixture()
  fs.renameSync(workspace, path.join(base, "original"))
  fs.mkdirSync(workspace)
  expect(() => publish([{ path: "file" }])).toThrow("workspace-changed")
  expect(fs.readdirSync(workspace)).toEqual([])
})

test("rejects unsafe paths before making any batch writes", () => {
  for (const target of ["../outside", "/absolute", "", ".", "nested/../outside", "a//b", "a\0b"]) {
    const { workspace, publish } = fixture(["first", "second"])
    expect(() => publish([{ path: "first" }, { path: target }])).toThrow(FilePolicyError)
    expect(fs.readdirSync(workspace)).toEqual([])
  }
})

test("rejects directory targets and preserves already-published files on later policy rejection", () => {
  const { workspace, publish } = fixture(["first", "second"])
  fs.mkdirSync(path.join(workspace, "directory"))
  expect(() => publish([{ path: "first" }, { path: "directory" }])).toThrow(FilePolicyError)
  expect(fs.readFileSync(path.join(workspace, "first"), "utf8")).toBe("first")
  expect(fs.statSync(path.join(workspace, "directory")).isDirectory()).toBe(true)
})

test("guest manifest rejects malformed entries and unsupported mode values", () => {
  for (const input of [
    "null",
    "{}",
    '[{"path":3}]',
    '[{"path":"file","mode":-1}]',
    '[{"path":"file","mode":4096}]',
  ]) {
    expect(() => parseManifest(input)).toThrow()
  }
  expect(parseManifest('[{"path":"file","mode":0}]')).toEqual([{ path: "file", mode: 0 }])
})

test("rejects a symlink workspace instead of silently pinning a different path", () => {
  const { base, workspace } = fixture()
  const alias = path.join(base, "alias")
  fs.symlinkSync(workspace, alias)
  expect(() => workspaceIdentity(alias)).toThrow("workspace-changed")
})
