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
        '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))',
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

  // Guard proof: drop the forwarder's rules from buildSeatbeltProfile; the profile lets a command
  // connect to, or move, every sandbox's forwarder.
  test.each([
    ["none", { mode: "none" }, ["(deny network-outbound)"]],
    ["restricted", { mode: "restricted", allow: [] }, []],
    ["all", { mode: "all" }, []],
  ] as const)('network.mode="%s" opens the forwarder root to this sandbox\'s directory alone', (_label, network, before) => {
    const profile = buildSeatbeltProfile({
      workingDirectory: "/private/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      denyReadPaths: [],
      network,
      forwarder: {
        root: "/private/tmp/sixb-credentials-501",
        directory: "/private/tmp/sixb-credentials-501/a1",
      },
    })
    const lines = profile.trimEnd().split("\n")

    expect(lines.filter((line) => line.includes("network-outbound"))).toEqual([
      ...before,
      '(deny network-outbound (subpath "/private/tmp/sixb-credentials-501"))',
      '(allow network-outbound (subpath "/private/tmp/sixb-credentials-501/a1"))',
    ])
    // Last, after the /private/tmp allow it narrows.
    expect(lines.at(-1)).toBe('(deny file-write* (subpath "/private/tmp/sixb-credentials-501"))')
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

    expect(profile.trimEnd().split("\n").slice(-4)).toEqual([
      '(deny file-write* (literal "/Users/ada") (literal "/Users"))',
      '(deny file-read* file-write* (subpath "/Users/ada/acme"))',
      '(deny file-write* (literal "/private/tmp/wd") (literal "/private/tmp") (literal "/private"))',
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
