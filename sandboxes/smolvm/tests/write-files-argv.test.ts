import { describe, expect, test } from "bun:test"
import { buildWriteFilesScript, shellQuote } from "../src/smolvm-sandbox"

test.each([
  ["wraps a plain value in single quotes", "abc", "'abc'"],
  ["escapes an embedded single quote so the value cannot break out", "a'b", "'a'\\''b'"],
  ["keeps shell metacharacters literal", "$(rm -rf /); `id`", "'$(rm -rf /); `id`'"],
])("shellQuote %s", (_label, value, quoted) => {
  expect(shellQuote(value)).toBe(quoted)
})

describe("buildWriteFilesScript", () => {
  test("aborts on the first failure and base64-decodes each file into a quoted path", () => {
    // If the path were interpolated unquoted, `$(...)` would execute at write time.
    const bytes = new Uint8Array([0x00, 0xff, 0x10])
    const script = buildWriteFilesScript([{ path: "/w/$(touch pwned).dat", contents: bytes }], "/w")
    expect(script.startsWith("set -e\n")).toBe(true)
    expect(script).toContain("mkdir -p '/w'")
    const encoded = Buffer.from(bytes).toString("base64")
    expect(script).toContain(`printf %s '${encoded}' | base64 -d > '/w/$(touch pwned).dat'`)
  })

  test("emits chmod with an octal mode only when one is set", () => {
    const withMode = buildWriteFilesScript(
      [{ path: "/w/run.sh", contents: "x", mode: 0o755 }],
      "/w"
    )
    expect(withMode).toContain("chmod 755 '/w/run.sh'")
    const withoutMode = buildWriteFilesScript([{ path: "/w/plain.txt", contents: "x" }], "/w")
    expect(withoutMode).not.toContain("chmod")
  })

  // Written as root; the commands that read and change them run as the unprivileged user.
  test("gives the file, and each directory it creates in the working directory, to the command user", () => {
    const script = buildWriteFilesScript(
      [
        { path: "/w/a/b/one.txt", contents: "1" },
        { path: "/w/a/two.txt", contents: "2" },
        { path: "/elsewhere/three.txt", contents: "3" },
      ],
      "/w"
    )
    expect(script.split("\n").at(-1)).toBe(
      "chown 65534:65534 '/w/a/b/one.txt' '/w/a/b' '/w/a' '/w/a/two.txt'"
    )
  })
})
