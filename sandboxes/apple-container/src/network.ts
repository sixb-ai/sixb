import type { SandboxNetworkPolicy } from "@sixb/core"

export interface AppleContainerNetworkResolution {
  /** Args passed to `container create`. */
  readonly createArgs: readonly string[]
  /** User-defined network owned by this sandbox and deleted during destroy. */
  readonly ownedNetworkName?: string
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export function resolveAppleContainerNetwork(input: {
  readonly id: string
  readonly policy: SandboxNetworkPolicy
  readonly defaultNetworkName: string
  readonly internalNetworkPrefix: string
}): AppleContainerNetworkResolution {
  assertSafeName(input.id, "Apple Container sandbox id")
  if (input.policy.mode === "none") {
    const ownedNetworkName = `${input.internalNetworkPrefix}${input.id}`
    assertSafeName(ownedNetworkName, "Apple Container network name")
    return {
      createArgs: ["--network", ownedNetworkName],
      ownedNetworkName,
    }
  }

  assertSafeName(input.defaultNetworkName, "Apple Container default network name")
  return { createArgs: ["--network", input.defaultNetworkName] }
}

export function warnIfRestrictedDowngraded(policy: SandboxNetworkPolicy): void {
  if (policy.mode !== "restricted") {
    return
  }
  console.warn(
    "[Sandbox] apple-container cannot enforce per-origin restricted egress with the documented Apple Container CLI; using the configured network as allow-all. Use smolvm or Vercel when restricted egress must be enforced."
  )
}

function assertSafeName(value: string, label: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new TypeError(
      `[Sandbox] ${label} must start with an alphanumeric character and contain only letters, numbers, '.', '_' or '-': ${value}`
    )
  }
}
