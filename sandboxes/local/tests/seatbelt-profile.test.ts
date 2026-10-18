import { describe, expect, test } from "bun:test"
import { buildSeatbeltArgv, buildSeatbeltProfile } from "../src/isolation/seatbelt"

describe("buildSeatbeltProfile", () => {
  test("canonical profile with network blocked and no extra paths", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: "/private/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      network: { mode: "none" },
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

  // Local isolation cannot enforce an allow list, so restricted is best-effort host network.
  test.each([
    ["all", { mode: "all" }],
    [
      "restricted",
      { mode: "restricted", allow: [{ name: "sixb-api", origin: "http://127.0.0.1:3000" }] },
    ],
  ] as const)('network.mode="%s" drops the network-outbound deny', (_label, network) => {
    const profile = buildSeatbeltProfile({
      workingDirectory: "/private/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      network,
    })

    expect(profile).not.toContain("network-outbound")
    expect(profile).toContain("(deny file-write*)")
  })

  test("readWritePaths add file-write allow rules; readOnlyPaths are informational", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: "/private/tmp/wd",
      readOnlyPaths: ["/etc/secrets"],
      readWritePaths: ["/private/var/cache/agent"],
      network: { mode: "none" },
    })

    expect(profile).toContain('(allow file-write* (subpath "/private/var/cache/agent"))')
    expect(profile).not.toContain("/etc/secrets")
  })

  test("escapes quotes and backslashes in subpath strings", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: '/tmp/with "quotes"\\and\\backslashes',
      readOnlyPaths: [],
      readWritePaths: [],
      network: { mode: "none" },
    })

    expect(profile).toContain(
      '(allow file-write* (subpath "/tmp/with \\"quotes\\"\\\\and\\\\backslashes"))'
    )
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
