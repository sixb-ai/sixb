import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { assertPrivateRoot, CredentialForwarder } from "../src/credential-forwarder"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "sixb-forwarder-root-"))
  directories.push(directory)
  return directory
}

const uid = process.getuid?.() ?? 0

describe("CredentialForwarder", () => {
  test("each forwarder listens in its own directory under this user's private root", async () => {
    const first = await CredentialForwarder.start()
    const second = await CredentialForwarder.start()
    try {
      expect(first.root).toBe(second.root)
      expect(dirname(first.directory)).toBe(first.root)
      expect(dirname(second.directory)).toBe(first.root)
      expect(first.directory).not.toBe(second.directory)
      expect(statSync(first.root).mode & 0o777).toBe(0o700)
      expect(first.urlFor("http://127.0.0.1:1").length).toBeLessThan(100)
    } finally {
      await first.stop()
    }

    expect(() => statSync(first.directory)).toThrow()
    expect(statSync(second.directory).isDirectory()).toBe(true)
    await second.stop()
  })

  // Guard proof: drop the conditions from assertPrivateRoot; each root below is accepted.
  test("a root this user doesn't own alone is refused", () => {
    const directory = scratch()

    const link = join(directory, "link")
    mkdirSync(join(directory, "target"), { mode: 0o700 })
    symlinkSync(join(directory, "target"), link)
    expect(() => assertPrivateRoot(link, lstatSync(link), uid)).toThrow(/only uid/)

    const shared = join(directory, "shared")
    mkdirSync(shared)
    chmodSync(shared, 0o755)
    expect(() => assertPrivateRoot(shared, lstatSync(shared), uid)).toThrow(/only uid/)

    const own = join(directory, "own")
    mkdirSync(own, { mode: 0o700 })
    expect(() => assertPrivateRoot(own, lstatSync(own), uid + 1)).toThrow(/only uid/)
    expect(() => assertPrivateRoot(own, lstatSync(own), uid)).not.toThrow()
  })
})
