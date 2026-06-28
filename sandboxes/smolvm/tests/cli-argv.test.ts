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
  test("includes name, image, and volume", () => {
    const argv = buildCreateArgv(config, {
      id: "run-1",
      network: [],
      volume: "/tmp/wd:/tmp/wd",
    })
    expect(argv).toEqual([
      "smolvm",
      "machine",
      "create",
      "--name",
      "run-1",
      "--image",
      "node:22-slim",
      "--volume",
      "/tmp/wd:/tmp/wd",
    ])
  })

  test("appends storage and overlay sizes when configured", () => {
    const argv = buildCreateArgv(
      { ...config, storageGiB: 40, overlayGiB: 8 },
      { id: "run-1", network: [], volume: "/wd:/wd" }
    )
    expect(argv).toContain("--storage")
    expect(argv[argv.indexOf("--storage") + 1]).toBe("40")
    expect(argv).toContain("--overlay")
    expect(argv[argv.indexOf("--overlay") + 1]).toBe("8")
  })

  test("omits --image for a bare machine (no image configured)", () => {
    const argv = buildCreateArgv({ bin: "smolvm" }, { id: "run-1", network: [], volume: "/wd:/wd" })
    expect(argv).not.toContain("--image")
    expect(argv).toEqual(["smolvm", "machine", "create", "--name", "run-1", "--volume", "/wd:/wd"])
  })

  test("appends network flags last", () => {
    const argv = buildCreateArgv(config, {
      id: "run-1",
      network: ["--net", "--allow-host", "api.example.com"],
      volume: "/wd:/wd",
    })
    expect(argv.slice(-3)).toEqual(["--net", "--allow-host", "api.example.com"])
  })
})

describe("buildStartArgv / buildStopArgv / buildRemoveArgv", () => {
  test("start", () => {
    expect(buildStartArgv(config, "run-1")).toEqual([
      "smolvm",
      "machine",
      "start",
      "--name",
      "run-1",
    ])
  })

  test("stop", () => {
    expect(buildStopArgv(config, "run-1")).toEqual(["smolvm", "machine", "stop", "--name", "run-1"])
  })

  test("delete passes --force to skip the confirmation prompt", () => {
    expect(buildRemoveArgv(config, "run-1")).toEqual([
      "smolvm",
      "machine",
      "delete",
      "--name",
      "run-1",
      "--force",
    ])
  })
})

describe("isLocalImageArchive", () => {
  test("true for .tar / .tar.gz / .tgz paths", () => {
    expect(isLocalImageArchive("/abs/node22.tar")).toBe(true)
    expect(isLocalImageArchive("./images/agent.tar.gz")).toBe(true)
    expect(isLocalImageArchive("agent.TGZ")).toBe(true)
  })

  test("false for registry references", () => {
    expect(isLocalImageArchive("node:22")).toBe(false)
    expect(isLocalImageArchive("ghcr.io/acme/agent:latest")).toBe(false)
    expect(isLocalImageArchive("alpine")).toBe(false)
  })
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

  test("injects env vars as repeated --env KEY=VAL before the -- separator", () => {
    const argv = buildExecArgv(config, {
      id: "run-1",
      cwd: "/work",
      command: "bash",
      args: ["-lc", "env"],
      env: { SIXB_API_BASE_URL: "http://host/x", SIXB_RUN_ID: "run-1" },
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
      "SIXB_RUN_ID=run-1",
    ])
    expect(argv.slice(dashDash + 1)).toEqual(["bash", "-lc", "env"])
  })

  test("keeps each KEY=VAL a single argv element even with spaces", () => {
    const argv = buildExecArgv(config, {
      id: "run-1",
      cwd: "/work",
      command: "bash",
      args: ["-lc", "true"],
      env: { GREETING: "hello world" },
    })
    expect(argv).toContain("GREETING=hello world")
  })
})
