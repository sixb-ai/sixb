import { randomUUID } from "node:crypto"
import { posix } from "node:path"
import {
  type CreateSandboxOptions,
  type Sandbox,
  SandboxError,
  type SandboxFactory,
  type SandboxSessionOptions,
} from "@sixb/core/sandboxes"
import {
  type AzureCreateRequest,
  AzureSandboxRequestError,
  createAzureSandboxClient,
} from "./azure-client"
import { AzureSandbox } from "./azure-sandbox"
import { installSupervisor, validateEnvironment } from "./command-execution"
import {
  type AzureLifecycleOptions,
  deleteAzureSandbox,
  positiveMilliseconds,
  waitForRunning,
  withLifecycleDeadline,
} from "./lifecycle"
import { resolveNetwork } from "./network"
import type { AzureSandboxFactoryOptions } from "./options"

/** Ephemeral Azure provider with validated creation-time egress and supervised workloads. */
export class AzureSandboxFactory implements SandboxFactory {
  private readonly client
  private readonly lifecycle: AzureLifecycleOptions
  private readonly provisionTimeoutMs: number
  private readonly source: AzureCreateRequest["sourcesRef"]
  private readonly resources: AzureCreateRequest["resources"]
  private readonly defaults: SandboxSessionOptions

  constructor(options: AzureSandboxFactoryOptions) {
    assertEphemeral(options)
    this.provisionTimeoutMs = positiveMilliseconds(
      options.provisionTimeoutMs ?? 120_000,
      "provisionTimeoutMs"
    )
    this.lifecycle = {
      teardownTimeoutMs: positiveMilliseconds(
        options.teardownTimeoutMs ?? 60_000,
        "teardownTimeoutMs"
      ),
      pollIntervalMs: positiveMilliseconds(options.pollIntervalMs ?? 1000, "pollIntervalMs"),
    }
    this.source = resolveImage(options.image)
    this.resources = resolveResources(options.resources)
    this.defaults = resolveSession({}, options)
    this.client = createAzureSandboxClient(options)
  }

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    assertEphemeral(options)
    const session = resolveSession(this.defaults, options)
    const attemptId = randomUUID()
    let id: string | undefined
    try {
      return await withLifecycleDeadline(
        "provisioning",
        this.provisionTimeoutMs,
        async (signal) => {
          const resource = await this.client.create(
            {
              sourcesRef: this.source,
              resources: this.resources,
              labels: { "sixb-provider": "azure", "sixb-provisioning-id": attemptId },
              egressPolicy: resolveNetwork(session.network).egress,
              // Recover idle instances after worker crashes. These are not command deadlines.
              lifecycle: {
                autoSuspend: { enabled: true, interval: 300, mode: "Disk" },
                autoDelete: { enabled: true, deleteIntervalSeconds: 600 },
              },
            },
            { signal }
          )
          id = resource.id
          await waitForRunning(this.client, resource, this.lifecycle.pollIntervalMs, signal)
          const supervisorRoot = await installSupervisor(
            this.client,
            id,
            session.workingDirectory,
            signal,
            session.network?.mode !== "none"
          )
          signal.throwIfAborted()
          return new AzureSandbox(id, this.client, session, this.lifecycle, supervisorRoot)
        }
      )
    } catch (error) {
      if (id === undefined) {
        // Never retry create or delete by a guessed name after an uncertain response.
        throw new SandboxError(
          `[Sandbox] Azure provisioning returned no sandbox ID.${error instanceof AzureSandboxRequestError ? ` ${error.message}` : ""} Inspect the group's sixb-provisioning-id label ${attemptId} before retrying; an instance may exist.`
        )
      }
      try {
        await deleteAzureSandbox(this.client, id, this.lifecycle)
      } catch {
        throw new SandboxError(
          `[Sandbox] Azure provisioning failed and deletion of sandbox ${id} could not be confirmed. Inspect and reclaim this sandbox before retrying.`
        )
      }
      if (error instanceof SandboxError) throw error
      throw new SandboxError("[Sandbox] Azure provisioning failed; its sandbox was deleted.")
    }
  }
}

function assertEphemeral(options: object): void {
  if (("persistence" in options && options.persistence !== undefined) || "persistent" in options) {
    throw new SandboxError("[Sandbox] Azure named persistence is not supported; omit persistence.")
  }
}

function resolveImage(
  image: AzureSandboxFactoryOptions["image"]
): AzureCreateRequest["sourcesRef"] {
  if (image?.type === "public" && typeof image.name === "string" && image.name.trim()) {
    return { diskImage: { name: image.name, isPublic: true } }
  }
  if (image?.type === "disk" && typeof image.id === "string" && image.id.trim()) {
    return { diskImage: { id: image.id } }
  }
  throw new SandboxError("[Sandbox] Azure image requires a public name or imported disk image ID.")
}

function resolveResources(
  resources: AzureSandboxFactoryOptions["resources"]
): AzureCreateRequest["resources"] {
  if (resources === undefined) return { cpu: "1", memory: "2048Mi", disk: "20Gi" }
  if (
    !Number.isFinite(resources.vcpus) ||
    resources.vcpus <= 0 ||
    !Number.isSafeInteger(resources.memoryMiB) ||
    resources.memoryMiB <= 0 ||
    !Number.isSafeInteger(resources.diskGiB) ||
    resources.diskGiB <= 0
  ) {
    throw new SandboxError(
      "[Sandbox] Azure resources require positive vcpus and positive integer memoryMiB/diskGiB."
    )
  }
  return {
    cpu: String(resources.vcpus),
    memory: `${resources.memoryMiB}Mi`,
    disk: `${resources.diskGiB}Gi`,
  }
}

function resolveSession(
  defaults: SandboxSessionOptions,
  options: SandboxSessionOptions
): SandboxSessionOptions & { readonly workingDirectory: string } {
  const network = resolveNetwork(options.network ?? defaults.network).policy
  const directory = options.workingDirectory ?? defaults.workingDirectory ?? "/workspace"
  if (typeof directory !== "string" || !directory || directory.includes("\0")) {
    throw new SandboxError("[Sandbox] Azure workingDirectory must be a non-empty path without NUL.")
  }
  const timeout = options.timeout ?? defaults.timeout
  if (timeout !== undefined) positiveMilliseconds(timeout, "timeout")
  validateEnvironment(defaults.env)
  validateEnvironment(options.env)
  return {
    workingDirectory: posix.resolve("/", directory),
    env: Object.freeze({ ...defaults.env, ...options.env }),
    timeout,
    network,
  }
}
