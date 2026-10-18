import { expect, test } from "bun:test"
import { evaluateSmolvm, type ProbeInput } from "../src/preflight"

const missing = () => false
// macOS (Hypervisor.framework) and Windows (WHP) need no KVM and are not probed for it.
const cases: [label: string, overrides: Partial<ProbeInput>, ok: boolean, message: string][] = [
  ["ok on linux with binary and kvm", {}, true, "ready"],
  ["not ok when binary is missing", { hasBinary: missing }, false, "not found"],
  ["not ok on linux without /dev/kvm", { hasKvm: missing }, false, "KVM"],
  ["ok on darwin without kvm", { platform: "darwin", hasKvm: missing }, true, "ready"],
  ["ok on win32 without kvm", { platform: "win32", hasKvm: missing }, true, "ready"],
]

test.each(cases)("evaluateSmolvm %s", (_label, overrides, ok, message) => {
  const probe = evaluateSmolvm({
    bin: "smolvm",
    platform: "linux",
    hasBinary: () => true,
    hasKvm: () => true,
    ...overrides,
  })
  expect(probe.ok).toBe(ok)
  expect(probe.message).toContain(message)
})
