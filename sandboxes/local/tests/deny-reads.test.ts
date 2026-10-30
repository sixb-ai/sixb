import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SandboxIsolationUnavailableError } from "@sixb/core"
import { detectIsolation } from "../src/isolation/detect"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A project on the host, as `sixb dev` runs one: its secrets beside its source. */
function project(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sixb-deny-reads-")))
  directories.push(directory)
  writeFileSync(join(directory, ".env"), "SIXB_AUTH_SECRET=do-not-read\n")
  writeFileSync(join(directory, "README.md"), "# Acme\n")
  return directory
}

const backend = detectIsolation().backend

// Guard proof: drop the denied paths from buildSeatbeltProfile (macOS) or buildBwrapArgv (Linux);
// each read below succeeds.
describe.skipIf(backend === "none")(`denyReadPaths (${backend})`, () => {
  test("a denied project can't be read or written; other host files still can", async () => {
    const denied = project()
    const allowed = project()
    const sandbox = await new LocalSandboxFactory({ denyReadPaths: [denied] }).create()
    try {
      const read = await sandbox.runCommand("cat", [join(denied, ".env")])
      expect(read.exitCode).not.toBe(0)
      expect(read.stdout).not.toContain("do-not-read")

      const listing = await sandbox.runCommand("ls", ["-a", denied])
      expect(listing.stdout).not.toContain(".env")

      await sandbox.runCommand("/bin/sh", ["-c", `echo x > ${join(denied, "planted.txt")}`])
      expect(existsSync(join(denied, "planted.txt"))).toBe(false)

      const other = await sandbox.runCommand("cat", [join(allowed, "README.md")])
      expect(other.stdout).toBe("# Acme\n")
    } finally {
      await sandbox.destroy()
    }
  })

  // Guard proof: drop the ancestors' rule from buildSeatbeltProfile; the moved secret is read.
  test("a denied path can't be read by moving the directory above it", async () => {
    const directory = project()
    const sandbox = await new LocalSandboxFactory({
      denyReadPaths: [join(directory, ".env")],
    }).create()
    try {
      const moved = `${directory}-moved`
      directories.push(moved)
      const read = await sandbox.runCommand("/bin/sh", [
        "-c",
        `mv ${directory} ${moved}; cat ${join(moved, ".env")}`,
      ])
      expect(read.stdout).not.toContain("do-not-read")
    } finally {
      await sandbox.destroy()
    }
  })

  test("a denied file inside the working directory hides only that file", async () => {
    const directory = project()
    const sandbox = await new LocalSandboxFactory({
      denyReadPaths: [join(directory, ".env")],
    }).create({ workingDirectory: directory })
    try {
      const secret = await sandbox.runCommand("cat", [".env"])
      expect(secret.stdout).not.toContain("do-not-read")

      const readme = await sandbox.runCommand("cat", ["README.md"])
      expect(readme.stdout).toBe("# Acme\n")
    } finally {
      await sandbox.destroy()
    }
  })
})

// Seatbelt matches paths when a command touches them; bwrap can only cover what exists.
test.skipIf(backend !== "seatbelt")(
  "seatbelt denies a path created after the sandbox",
  async () => {
    const directory = project()
    const later = join(directory, "later.env")
    const sandbox = await new LocalSandboxFactory({ denyReadPaths: [later] }).create()
    try {
      writeFileSync(later, "SIXB_AUTH_SECRET=do-not-read\n")

      const read = await sandbox.runCommand("cat", [later])
      expect(read.exitCode).not.toBe(0)
      expect(read.stdout).not.toContain("do-not-read")
    } finally {
      await sandbox.destroy()
    }
  }
)

describe("denyReadPaths without an isolation backend", () => {
  test("creation fails rather than letting the paths be read", async () => {
    const factory = new LocalSandboxFactory({ isolation: "none", denyReadPaths: [project()] })

    const error = await factory.create().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SandboxIsolationUnavailableError)
    expect(String(error)).toContain("denyReadPaths needs an isolation backend")
  })
})
