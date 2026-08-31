import type { Sandbox } from "@sixb/core"

/** The sandbox plus its run-scoped environment, resolved lazily when first needed. */
export interface AgentSandboxHandle {
  readonly sandbox: Sandbox
  readonly env?: Readonly<Record<string, string>>
}
