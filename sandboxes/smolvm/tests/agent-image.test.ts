import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  agentDockerfilePath,
  agentImageName,
  defaultAgentImageCandidates,
  defaultAgentImagePath,
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
