import { describe, expect, test } from "bun:test"
import { buildSeatbeltArgv, buildSeatbeltProfile } from "../src/isolation/seatbelt"

describe("buildSeatbeltProfile", () => {
  test("canonical profile with network blocked and no extra paths", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: "/private/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      allowNetwork: false,
    })

    expect(profile).toBe(
      [
        "(version 1)",
        "(allow default)",
        "(deny network-outbound)",
        "(deny file-write*)",
        '(allow file-write* (subpath "/private/tmp/wd"))',
        '(allow file-write* (subpath "/private/tmp"))',
        '(allow file-write* (subpath "/private/var/folders"))',
        "",
      ].join("\n")
    )
  })

  test("allowNetwork true drops the network-outbound deny", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: "/private/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      allowNetwork: true,
    })

    expect(profile).not.toContain("network-outbound")
    expect(profile).toContain("(allow default)")
  })

  test("readWritePaths produce additional file-write allow rules", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: "/private/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: ["/private/var/cache/agent"],
      allowNetwork: false,
    })

    expect(profile).toContain('(allow file-write* (subpath "/private/var/cache/agent"))')
  })

  test("escapes quotes and backslashes in subpath strings", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: '/tmp/with "quotes"\\and\\backslashes',
      readOnlyPaths: [],
      readWritePaths: [],
      allowNetwork: false,
    })

    expect(profile).toContain(
      '(allow file-write* (subpath "/tmp/with \\"quotes\\"\\\\and\\\\backslashes"))'
    )
  })

  test("readOnlyPaths is informational on Seatbelt", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: "/private/tmp/wd",
      readOnlyPaths: ["/etc/secrets"],
      readWritePaths: [],
      allowNetwork: false,
    })

    expect(profile).not.toContain("/etc/secrets")
  })
})

describe("buildSeatbeltArgv", () => {
  test("argv passes profile inline and command verbatim", () => {
    const argv = buildSeatbeltArgv({
      profile: "(version 1)\n(allow default)\n",
      command: "echo",
      args: ["a; rm -rf /"],
    })

    expect(argv).toEqual([
      "sandbox-exec",
      "-p",
      "(version 1)\n(allow default)\n",
      "echo",
      "a; rm -rf /",
    ])
  })
})
