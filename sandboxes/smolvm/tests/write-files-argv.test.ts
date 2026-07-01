import { describe, expect, test } from "bun:test"
import { buildWriteFilesScript, shellQuote } from "../src/smolvm-sandbox"

describe("shellQuote", () => {
  test("wraps a plain value in single quotes", () => {
    expect(shellQuote("abc")).toBe("'abc'")
  })

  test("escapes an embedded single quote so the value cannot break out", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })

  test("keeps shell metacharacters literal inside the quotes", () => {
    expect(shellQuote("$(rm -rf /); `id`")).toBe("'$(rm -rf /); `id`'")
  })
})

describe("buildWriteFilesScript", () => {
  test("aborts on the first failure and base64-decodes each file into place", () => {
    const script = buildWriteFilesScript([{ path: "/w/a.txt", contents: "hi" }])
    expect(script.startsWith("set -e\n")).toBe(true)
    expect(script).toContain("mkdir -p '/w'")
    const encoded = Buffer.from("hi").toString("base64")
    expect(script).toContain(`printf %s '${encoded}' | base64 -d > '/w/a.txt'`)
  })

  test("emits chmod with an octal mode only when one is set", () => {
    const withMode = buildWriteFilesScript([{ path: "/w/run.sh", contents: "x", mode: 0o755 }])
    expect(withMode).toContain("chmod 755 '/w/run.sh'")
    const withoutMode = buildWriteFilesScript([{ path: "/w/plain.txt", contents: "x" }])
    expect(withoutMode).not.toContain("chmod")
  })

  test("base64 keeps binary contents intact", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10])
    const script = buildWriteFilesScript([{ path: "/w/b.dat", contents: bytes }])
    expect(script).toContain(`printf %s '${Buffer.from(bytes).toString("base64")}' | base64 -d`)
  })

  test("a path with shell metacharacters is quoted, not interpolated", () => {
    // If the path were interpolated unquoted, `$(...)` would execute at write time. It must appear
    // only inside single quotes.
    const script = buildWriteFilesScript([{ path: "/w/$(touch pwned).txt", contents: "x" }])
    expect(script).toContain("> '/w/$(touch pwned).txt'")
    expect(script).toContain("mkdir -p '/w'")
  })
})
