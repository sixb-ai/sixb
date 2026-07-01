import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  agentDockerfilePath,
  agentImageName,
  buildImageBuildArgv,
  buildImageSaveArgv,
  defaultAgentImageCandidates,
  defaultAgentImagePath,
  detectBuilder,
} from "../src/agent-image"

describe("agent image paths", () => {
  test("default path lives under the XDG cache when set", () => {
    const prev = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache-test"
    try {
      expect(defaultAgentImagePath()).toBe("/tmp/xdg-cache-test/sixb/smolvm/sixb-agent.tar")
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_CACHE_HOME
      } else {
        process.env.XDG_CACHE_HOME = prev
      }
    }
  })

  test("default path is a .tar (so it is treated as a local archive)", () => {
    const prev = process.env.XDG_CACHE_HOME
    delete process.env.XDG_CACHE_HOME
    try {
      expect(defaultAgentImagePath().endsWith("/sixb/smolvm/sixb-agent.tar")).toBe(true)
    } finally {
      if (prev !== undefined) process.env.XDG_CACHE_HOME = prev
    }
  })

  test("the canonical Dockerfile ships with the package", () => {
    expect(existsSync(agentDockerfilePath())).toBe(true)
  })

  test("targeted build filenames encode the arch", () => {
    expect(agentImageName("linux/amd64")).toBe("sixb-agent-amd64.tar")
    expect(agentImageName("arm64")).toBe("sixb-agent-arm64.tar")
  })

  test("default lookup prefers the canonical archive, then a cross-built arch archive", () => {
    const prev = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = "/tmp/xdg-cache-test"
    try {
      const candidates = defaultAgentImageCandidates()
      // The canonical host build is preferred over the arch-suffixed cross-build archive.
      expect(candidates[0]).toBe("/tmp/xdg-cache-test/sixb/smolvm/sixb-agent.tar")
      expect(candidates[1]).toMatch(/\/sixb\/smolvm\/sixb-agent-(amd64|arm64|[^/]+)\.tar$/)
      expect(candidates[1]).not.toBe(candidates[0])
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_CACHE_HOME
      } else {
        process.env.XDG_CACHE_HOME = prev
      }
    }
  })
})

describe("agent image build argv", () => {
  test("build argv omits --platform for a host build", () => {
    expect(
      buildImageBuildArgv({
        builder: "docker",
        tag: "sixb-agent",
        dockerfile: "/pkg/agent-image/Dockerfile",
        contextDir: "/pkg/agent-image",
      })
    ).toEqual([
      "docker",
      "build",
      "-t",
      "sixb-agent",
      "-f",
      "/pkg/agent-image/Dockerfile",
      "/pkg/agent-image",
    ])
  })

  test("build argv threads --platform right after build for a cross-build", () => {
    expect(
      buildImageBuildArgv({
        builder: "podman",
        platform: "linux/amd64",
        tag: "sixb-agent",
        dockerfile: "/pkg/agent-image/Dockerfile",
        contextDir: "/pkg/agent-image",
      })
    ).toEqual([
      "podman",
      "build",
      "--platform",
      "linux/amd64",
      "-t",
      "sixb-agent",
      "-f",
      "/pkg/agent-image/Dockerfile",
      "/pkg/agent-image",
    ])
  })

  test("save argv writes the tag to the output path", () => {
    expect(
      buildImageSaveArgv({ builder: "docker", tag: "sixb-agent", output: "/cache/sixb-agent.tar" })
    ).toEqual(["docker", "save", "sixb-agent", "-o", "/cache/sixb-agent.tar"])
  })
})

describe("detectBuilder", () => {
  test("prefers docker over podman", () => {
    expect(
      detectBuilder((cmd) => (cmd === "docker" || cmd === "podman" ? `/usr/bin/${cmd}` : null))
    ).toBe("docker")
  })

  test("falls back to podman when docker is absent", () => {
    expect(detectBuilder((cmd) => (cmd === "podman" ? "/usr/bin/podman" : null))).toBe("podman")
  })

  test("returns undefined when neither builder is on PATH", () => {
    expect(detectBuilder(() => null)).toBeUndefined()
  })
})
