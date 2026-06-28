import { describe, expect, test } from "bun:test"
import { evaluateSmolvm, type ProbeInput } from "../src/preflight"

function input(overrides: Partial<ProbeInput>): ProbeInput {
  return {
    bin: "smolvm",
    platform: "linux",
    hasBinary: () => true,
    hasKvm: () => true,
    ...overrides,
  }
}

describe("evaluateSmolvm", () => {
  test("ok on linux with binary and kvm", () => {
    expect(evaluateSmolvm(input({})).ok).toBe(true)
  })

  test("not ok when binary is missing", () => {
    const probe = evaluateSmolvm(input({ hasBinary: () => false }))
    expect(probe.ok).toBe(false)
    expect(probe.message).toContain("not found")
  })

  test("not ok on linux without /dev/kvm", () => {
    const probe = evaluateSmolvm(input({ hasKvm: () => false }))
    expect(probe.ok).toBe(false)
    expect(probe.message).toContain("KVM")
  })

  test("ok on darwin without kvm (Hypervisor.framework, not probed)", () => {
    const probe = evaluateSmolvm(input({ platform: "darwin", hasKvm: () => false }))
    expect(probe.ok).toBe(true)
  })

  test("ok on win32 without kvm (WHP, not probed)", () => {
    const probe = evaluateSmolvm(input({ platform: "win32", hasKvm: () => false }))
    expect(probe.ok).toBe(true)
  })
})
