import type { TokenCredential } from "@azure/core-auth"
import type { ParamsConfig, SandboxConfig, SandboxSessionOptions } from "@sixb/core/sandboxes"

/** An Azure identity credential; management credentials never enter the guest. */
export type AzureSandboxCredential = TokenCredential

export type AzureSandboxImage =
  | { readonly type: "public"; readonly name: string }
  | { readonly type: "disk"; readonly id: string }

export interface AzureSandboxResources {
  readonly vcpus: number
  readonly memoryMiB: number
  readonly diskGiB: number
}

/** Configuration for an existing sandbox group. Provision the group and RBAC separately. */
export interface AzureSandboxFactoryOptions<TParams extends ParamsConfig = ParamsConfig>
  extends SandboxSessionOptions,
    SandboxConfig<TParams> {
  readonly subscriptionId: string
  readonly resourceGroup: string
  readonly sandboxGroup: string
  /** Azure public-cloud region identifier, e.g. "westus3". */
  readonly region: string
  readonly image: AzureSandboxImage
  /** Defaults to 1 vCPU, 2048 MiB memory and 20 GiB disk. */
  readonly resources?: AzureSandboxResources
  /** Defaults to DefaultAzureCredential (including managed identity and Azure CLI). */
  readonly credential?: AzureSandboxCredential
  /** Per-request deadline including credential acquisition and response body, in milliseconds.
   * Defaults to 30 seconds. Separate from the command execution timeout and sandbox lifetime.
   */
  readonly requestTimeoutMs?: number
  /** Total creation/readiness/bootstrap deadline. Defaults to 120 seconds. */
  readonly provisionTimeoutMs?: number
  /** Deadline for each remote stop/delete, including confirmation. Defaults to 60 seconds.
   * Destroy waits for any pending stop before starting its separate delete budget. */
  readonly teardownTimeoutMs?: number
  /** Interval between lifecycle status requests. Defaults to one second. */
  readonly pollIntervalMs?: number
}
