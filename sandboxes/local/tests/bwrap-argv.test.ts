import { describe, expect, test } from "bun:test"
import { buildBwrapArgv } from "../src/isolation/bwrap"

describe("buildBwrapArgv", () => {
  test("canonical argv blocks the network and passes command and args verbatim after --", () => {
    const argv = buildBwrapArgv({
      command: "echo",
      args: ["a; rm -rf /", "$(whoami)"],
      workingDirectory: "/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      denyReadPaths: [],
      network: { mode: "none" },
    })

    expect(argv).toEqual([
      "bwrap",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      "/tmp/wd",
      "/tmp/wd",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--unshare-pid",
      "--unshare-net",
      "--die-with-parent",
      "--",
      "echo",
      "a; rm -rf /",
      "$(whoami)",
    ])
  })

  // Local isolation cannot enforce an allow list, so restricted is best-effort host network.
  test.each([
    ["all", { mode: "all" }],
    [
      "restricted",
      { mode: "restricted", allow: [{ name: "sixb-api", origin: "http://127.0.0.1:3000" }] },
    ],
  ] as const)('network.mode="%s" drops --unshare-net', (_label, network) => {
    const argv = buildBwrapArgv({
      command: "curl",
      args: [],
      workingDirectory: "/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      denyReadPaths: [],
      network,
    })

    expect(argv).not.toContain("--unshare-net")
    expect(argv).toContain("--unshare-pid")
  })

  test("read-only paths bind in input order after /, read-write paths after the working directory", () => {
    const argv = buildBwrapArgv({
      command: "echo",
      args: [],
      workingDirectory: "/tmp/wd",
      readOnlyPaths: ["/usr", "/opt/data"],
      readWritePaths: ["/var/cache/agent"],
      denyReadPaths: [],
      network: { mode: "none" },
    })

    expect(argv.slice(0, argv.indexOf("--proc"))).toEqual([
      "bwrap",
      "--ro-bind",
      "/",
      "/",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/opt/data",
      "/opt/data",
      "--bind",
      "/tmp/wd",
      "/tmp/wd",
      "--bind",
      "/var/cache/agent",
      "/var/cache/agent",
    ])
  })

  test("denied paths are covered after every bind: a directory by an empty tmpfs, a file by /dev/null", () => {
    const argv = buildBwrapArgv({
      command: "cat",
      args: [],
      workingDirectory: "/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: ["/var/cache/agent"],
      denyReadPaths: [
        { path: "/home/ada/acme", kind: "directory" },
        { path: "/tmp/wd/.env", kind: "file" },
      ],
      network: { mode: "none" },
    })

    expect(argv.slice(argv.indexOf("/var/cache/agent") + 2, argv.indexOf("--proc"))).toEqual([
      "--tmpfs",
      "/home/ada/acme",
      "--ro-bind",
      "/dev/null",
      "/tmp/wd/.env",
    ])
  })
})
