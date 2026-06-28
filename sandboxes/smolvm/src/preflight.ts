import { existsSync } from "node:fs"

export interface SmolvmProbe {
  readonly ok: boolean
  readonly message: string
}

/**
 * Inputs to evaluateSmolvm. Tests pass synthetic values for platform, binary
 * availability, and KVM presence without monkey-patching globals — same shape
 * as the local backend's detectIsolation.
 */
export interface ProbeInput {
  readonly bin: string
  readonly platform: NodeJS.Platform
  hasBinary(name: string): boolean
  hasKvm(): boolean
}

/**
 * Decide whether smolvm can run on this host, given gathered facts. Pure.
 *
 * - The binary must be present.
 * - On Linux, /dev/kvm is required (KVM virtualization). macOS uses
 *   Hypervisor.framework and Windows uses WHP, neither of which we probe here.
 */
export function evaluateSmolvm(input: ProbeInput): SmolvmProbe {
  if (!input.hasBinary(input.bin)) {
    return { ok: false, message: `smolvm binary '${input.bin}' not found` }
  }
  if (input.platform === "linux" && !input.hasKvm()) {
    return {
      ok: false,
      message: "smolvm requires KVM on Linux but /dev/kvm is unavailable",
    }
  }
  return { ok: true, message: `smolvm ready (${input.platform})` }
}

/** Probe the real host for smolvm availability. */
export function probeSmolvm(bin: string): SmolvmProbe {
  return evaluateSmolvm(defaultProbeInput(bin))
}

function defaultProbeInput(bin: string): ProbeInput {
  return {
    bin,
    platform: process.platform,
    hasBinary: (name) => (name.includes("/") ? existsSync(name) : Boolean(Bun.which(name))),
    hasKvm: () => existsSync("/dev/kvm"),
  }
}
