import { describe, expect, test } from "bun:test"
import {
  buildCreateArgv,
  buildExecArgv,
  buildRemoveArgv,
  buildStartArgv,
  buildStopArgv,
  isLocalImageArchive,
  type SmolvmCliConfig,
} from "../src/cli"

const config: SmolvmCliConfig = { bin: "smolvm", image: "node:22-slim" }

describe("buildCreateArgv", () => {
  // No row mounts a host volume: files reach the isolated guest only through writeFiles.
  test.each([
    [
      "names the machine and its image",
      config,
      [],
      ["smolvm", "machine", "create", "--name", "run-1", "--image", "node:22-slim"],
    ],
    [
      "omits --image for a bare machine",
      { bin: "smolvm" },
      [],
      ["smolvm", "machine", "create", "--name", "run-1"],
    ],
    [
      "appends storage and overlay sizes, then network flags last",
      { ...config, storageGiB: 40, overlayGiB: 8 },
      ["--net", "--allow-host", "api.example.com"],
      [
        "smolvm",
        "machine",
        "create",
        "--name",
        "run-1",
        "--image",
        "node:22-slim",
        "--storage",
        "40",
        "--overlay",
        "8",
        "--net",
        "--allow-host",
        "api.example.com",
      ],
    ],
  ] as const)("%s", (_label, cli, network, expected) => {
    expect(buildCreateArgv(cli, { id: "run-1", network })).toEqual([...expected])
  })
})

test("start, stop and delete address the machine by name; delete skips the confirmation prompt", () => {
  expect(buildStartArgv(config, "run-1")).toEqual(["smolvm", "machine", "start", "--name", "run-1"])
  expect(buildStopArgv(config, "run-1")).toEqual(["smolvm", "machine", "stop", "--name", "run-1"])
  expect(buildRemoveArgv(config, "run-1")).toEqual([
    "smolvm",
    "machine",
    "delete",
    "--name",
    "run-1",
    "--force",
  ])
})

test("isLocalImageArchive accepts .tar / .tar.gz / .tgz paths, not registry references", () => {
  expect(isLocalImageArchive("/abs/node22.tar")).toBe(true)
  expect(isLocalImageArchive("./images/agent.tar.gz")).toBe(true)
  expect(isLocalImageArchive("agent.TGZ")).toBe(true)
  expect(isLocalImageArchive("node:22")).toBe(false)
  expect(isLocalImageArchive("ghcr.io/acme/agent:latest")).toBe(false)
  expect(isLocalImageArchive("alpine")).toBe(false)
})

describe("buildExecArgv", () => {
  test("sets the workdir and forwards command + args after --", () => {
    const argv = buildExecArgv(config, {
      id: "run-1",
      cwd: "/work",
      command: "bash",
      args: ["-lc", "echo hi"],
      env: {},
    })
    expect(argv).toEqual([
      "smolvm",
      "machine",
      "exec",
      "--name",
      "run-1",
      "--workdir",
      "/work",
      "--",
      "bash",
      "-lc",
      "echo hi",
    ])
  })

  test("injects env vars as repeated single-element --env KEY=VAL before the -- separator", () => {
    const argv = buildExecArgv(config, {
      id: "run-1",
      cwd: "/work",
      command: "bash",
      args: ["-lc", "env"],
      env: { SIXB_API_BASE_URL: "http://host/x", GREETING: "hello world" },
    })
    const dashDash = argv.indexOf("--")
    expect(argv.slice(0, dashDash)).toEqual([
      "smolvm",
      "machine",
      "exec",
      "--name",
      "run-1",
      "--workdir",
      "/work",
      "--env",
      "SIXB_API_BASE_URL=http://host/x",
      "--env",
      "GREETING=hello world",
    ])
    expect(argv.slice(dashDash + 1)).toEqual(["bash", "-lc", "env"])
  })
})
