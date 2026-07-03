import { describe, expect, test } from "bun:test"
import {
  type AppleContainerCliConfig,
  buildCreateArgv,
  buildDeleteArgv,
  buildExecArgv,
  buildNetworkCreateArgv,
  buildNetworkDeleteArgv,
  buildStartArgv,
  buildStopArgv,
  normalizeDnsServers,
  normalizePorts,
} from "../src/cli"

const config: AppleContainerCliConfig = {
  bin: "container",
  image: "node:22-bookworm",
  cpus: "2",
  memory: "2G",
  platform: "linux",
  arch: "arm64",
  os: "linux",
  rosetta: true,
  readOnlyRootfs: true,
  mounts: [{ hostPath: "/host/work", containerPath: "/workspace", readOnly: true }],
  ports: [4100],
  dns: ["8.8.8.8"],
  createArgs: ["--label", "sixb=true"],
  stopTimeoutSeconds: 2,
}

describe("Apple Container CLI argv builders", () => {
  test("buildCreateArgv creates a long-lived container with resources, mounts, ports, and network", () => {
    const argv = buildCreateArgv(config, {
      id: "run-1",
      workingDirectory: "/workspace",
      env: { A: "factory" },
      networkArgs: ["--network", "default"],
    })

    expect(argv).toEqual([
      "container",
      "create",
      "--name",
      "run-1",
      "--env",
      "A=factory",
      "--dns",
      "8.8.8.8",
      "--network",
      "default",
      "--publish",
      "127.0.0.1:4100:4100/tcp",
      "--cpus",
      "2",
      "--memory",
      "2G",
      "--platform",
      "linux",
      "--arch",
      "arm64",
      "--os",
      "linux",
      "--rosetta",
      "--read-only",
      "--mount",
      "type=bind,source=/host/work,target=/workspace,readonly",
      "--label",
      "sixb=true",
      "node:22-bookworm",
      "/bin/sh",
      "-lc",
      expect.stringContaining("while :; do sleep"),
    ])
  })

  test("buildExecArgv forwards env, cwd, command, and args without a shell wrapper", () => {
    expect(
      buildExecArgv(config, {
        id: "run-1",
        cwd: "/workspace",
        command: "bash",
        args: ["-lc", "echo hi"],
        env: { A: "factory", B: "call" },
      })
    ).toEqual([
      "container",
      "exec",
      "--env",
      "A=factory",
      "--env",
      "B=call",
      "--workdir",
      "/workspace",
      "run-1",
      "bash",
      "-lc",
      "echo hi",
    ])
  })

  test("buildExecArgv can request interactive stdin for file writes", () => {
    expect(
      buildExecArgv(config, {
        id: "run-1",
        cwd: "/",
        command: "/bin/sh",
        args: ["-c", 'cat > "$1"', "sh", "/workspace/a.txt"],
        env: {},
        interactive: true,
      }).slice(0, 3)
    ).toEqual(["container", "exec", "--interactive"])
  })

  test("lifecycle argv builders match Apple Container commands", () => {
    expect(buildNetworkCreateArgv("container", "sixb-net")).toEqual([
      "container",
      "network",
      "create",
      "--internal",
      "sixb-net",
    ])
    expect(buildNetworkDeleteArgv("container", "sixb-net")).toEqual([
      "container",
      "network",
      "delete",
      "sixb-net",
    ])
    expect(buildStartArgv(config, "run-1")).toEqual(["container", "start", "run-1"])
    expect(buildStopArgv(config, "run-1")).toEqual(["container", "stop", "--time", "2", "run-1"])
    expect(buildDeleteArgv(config, "run-1")).toEqual(["container", "delete", "--force", "run-1"])
  })

  test("normalizePorts deduplicates and rejects invalid ports", () => {
    expect(normalizePorts([4100, 4100, 5200])).toEqual([4100, 5200])
    expect(() => normalizePorts([0])).toThrow(RangeError)
    expect(() => normalizePorts([65536])).toThrow(RangeError)
  })

  test("normalizeDnsServers deduplicates and rejects empty values", () => {
    expect(normalizeDnsServers(["8.8.8.8", "8.8.8.8", "1.1.1.1"])).toEqual(["8.8.8.8", "1.1.1.1"])
    expect(() => normalizeDnsServers([""])).toThrow(TypeError)
    expect(() => normalizeDnsServers([" 8.8.8.8"])).toThrow(TypeError)
  })
})
