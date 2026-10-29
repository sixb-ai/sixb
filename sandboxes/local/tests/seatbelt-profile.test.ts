import { describe, expect, test } from "bun:test"
import { buildSeatbeltArgv, buildSeatbeltProfile } from "../src/isolation/seatbelt"

describe("buildSeatbeltProfile", () => {
  test("canonical profile with network blocked and no extra paths", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: "/private/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      denyReadPaths: [],
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
      denyReadPaths: [],
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
      denyReadPaths: [],
      network: { mode: "none" },
    })

    expect(profile).toContain('(allow file-write* (subpath "/private/var/cache/agent"))')
    expect(profile).not.toContain("/etc/secrets")
  })

  test("denied paths come last, so no allow above reads or writes them", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: "/private/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      denyReadPaths: ["/Users/ada/acme", "/private/tmp/wd/.env"],
      network: { mode: "none" },
    })

    expect(profile.trimEnd().split("\n").slice(-2)).toEqual([
      '(deny file-read* file-write* (subpath "/Users/ada/acme"))',
      '(deny file-read* file-write* (subpath "/private/tmp/wd/.env"))',
    ])
  })

  test("escapes quotes and backslashes in subpath strings", () => {
    const profile = buildSeatbeltProfile({
      workingDirectory: '/tmp/with "quotes"\\and\\backslashes',
      readOnlyPaths: [],
      readWritePaths: [],
      denyReadPaths: [],
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
