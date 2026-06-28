import { describe, expect, test } from "bun:test"
import { buildBwrapArgv } from "../src/isolation/bwrap"

describe("buildBwrapArgv", () => {
  test("canonical argv with network blocked and no extra paths", () => {
    const argv = buildBwrapArgv({
      command: "echo",
      args: ["hi"],
      workingDirectory: "/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
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
      "hi",
    ])
  })

  test('network.mode="all" drops --unshare-net', () => {
    const argv = buildBwrapArgv({
      command: "curl",
      args: ["https://example.com"],
      workingDirectory: "/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      network: { mode: "all" },
    })

    expect(argv).not.toContain("--unshare-net")
    expect(argv).toContain("--unshare-pid")
  })

  test('network.mode="restricted" drops --unshare-net for local best-effort access', () => {
    const argv = buildBwrapArgv({
      command: "curl",
      args: ["http://127.0.0.1:3000"],
      workingDirectory: "/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      network: {
        mode: "restricted",
        allow: [{ name: "sixb-api", origin: "http://127.0.0.1:3000" }],
      },
    })

    expect(argv).not.toContain("--unshare-net")
  })

  test("readOnlyPaths produce --ro-bind pairs in input order", () => {
    const argv = buildBwrapArgv({
      command: "echo",
      args: [],
      workingDirectory: "/tmp/wd",
      readOnlyPaths: ["/usr", "/opt/data"],
      readWritePaths: [],
      network: { mode: "none" },
    })

    const usrIdx = argv.findIndex(
      (value, index) => value === "--ro-bind" && argv[index + 1] === "/usr"
    )
    const optIdx = argv.findIndex(
      (value, index) => value === "--ro-bind" && argv[index + 1] === "/opt/data"
    )
    expect(usrIdx).toBeGreaterThan(0)
    expect(optIdx).toBeGreaterThan(usrIdx)
  })

  test("readWritePaths produce --bind pairs after the workingDirectory bind", () => {
    const argv = buildBwrapArgv({
      command: "echo",
      args: [],
      workingDirectory: "/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: ["/var/cache/agent"],
      network: { mode: "none" },
    })

    const wdIdx = argv.findIndex(
      (value, index) => value === "--bind" && argv[index + 1] === "/tmp/wd"
    )
    const cacheIdx = argv.findIndex(
      (value, index) => value === "--bind" && argv[index + 1] === "/var/cache/agent"
    )
    expect(wdIdx).toBeGreaterThan(0)
    expect(cacheIdx).toBeGreaterThan(wdIdx)
  })

  test("command and args are passed verbatim after --", () => {
    const argv = buildBwrapArgv({
      command: "echo",
      args: ["a; rm -rf /", "$(whoami)"],
      workingDirectory: "/tmp/wd",
      readOnlyPaths: [],
      readWritePaths: [],
      network: { mode: "none" },
    })

    const dashDash = argv.indexOf("--")
    expect(dashDash).toBeGreaterThan(0)
    expect(argv.slice(dashDash + 1)).toEqual(["echo", "a; rm -rf /", "$(whoami)"])
  })
})
