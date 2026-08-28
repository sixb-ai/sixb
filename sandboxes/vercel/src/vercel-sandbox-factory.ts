import { randomUUID } from "node:crypto"
import {
  type CreateSandboxOptions,
  type Sandbox,
  SandboxError,
  type SandboxFactory,
  type SandboxNetworkPolicy,
} from "@sixb/core"
import { Sandbox as VercelSdkSandbox } from "@vercel/sandbox"
import { toVercelNetworkPolicy } from "./network"
import {
  type VercelCommandFinishedClient,
  VercelSandbox,
  type VercelSandboxClient,
} from "./vercel-sandbox"

export type VercelSandboxRuntime = "node26" | "node24" | "node22" | "python3.13"

export const DEFAULT_VERCEL_SANDBOX_RUNTIME: VercelSandboxRuntime = "node24"

export type VercelSandboxSource =
  | {
      readonly type: "git"
      readonly url: string
      readonly username?: string
      readonly password?: string
      readonly depth?: number
      readonly revision?: string
    }
  | {
      readonly type: "tarball"
      readonly url: string
    }

export interface VercelSandboxCredentials {
  readonly token: string
  readonly teamId: string
  readonly projectId: string
}

export interface VercelSnapshotRetentionPolicy {
  readonly count: number
  readonly expiration?: number
  readonly deleteEvicted?: boolean
}

export interface VercelSandboxFactoryOptions {
  /** Stock Vercel runtime. Ignored with `image`/`snapshotId`. Sixb explicitly defaults to node24. */
  readonly runtime?: VercelSandboxRuntime | (string & {})
  /** VCR image reference; agent images must satisfy `sixb-agent-runtime/v1`. */
  readonly image?: string
  /** Existing snapshot; agent snapshots must satisfy the same profile. Exclusive with image/source. */
  readonly snapshotId?: string
  /** Optional git/tarball source cloned or mounted by Vercel at sandbox creation. */
  readonly source?: VercelSandboxSource
  /** vCPU allocation; memory is 2048 MB per vCPU. */
  readonly resources?: { readonly vcpus: number }
  /** Ports to expose through Vercel sandbox domains. */
  readonly ports?: readonly number[]
  /** Vercel session lifetime in milliseconds. Separate from Sixb's per-command `timeout`. */
  readonly sessionTimeoutMs?: number
  /** Timeout used only for provider bootstrap commands, such as creating a custom cwd. */
  readonly setupTimeoutMs?: number
  /** Persist/snapshot the sandbox when stopped. Defaults to false for Sixb's per-run model. */
  readonly persistent?: boolean
  readonly snapshotExpiration?: number
  readonly keepLastSnapshots?: VercelSnapshotRetentionPolicy
  readonly tags?: Readonly<Record<string, string>>
  /** Prefix for generated Vercel sandbox names. */
  readonly namePrefix?: string
  /** Explicit Vercel API credentials. If omitted, the SDK resolves OIDC/env credentials. */
  readonly credentials?: VercelSandboxCredentials
  /** Default env merged into every sandbox the factory creates. */
  readonly env?: Readonly<Record<string, string>>
  /** Default per-command timeout in milliseconds. */
  readonly timeout?: number
  /** Default network policy. Overridable per-create. Defaults to deny-all. */
  readonly network?: SandboxNetworkPolicy
}

type VercelCreateSandboxParams = NonNullable<Parameters<typeof VercelSdkSandbox.create>[0]>
export type VercelCreateSandbox = (
  params: VercelCreateSandboxParams
) => Promise<VercelSandboxClient>

const DEFAULT_NAME_PREFIX = "sixb-"
const DEFAULT_SETUP_TIMEOUT_MS = 30_000

/** Pluggable factory for Vercel Sandbox-backed Sixb sandboxes. */
export class VercelSandboxFactory implements SandboxFactory {
  constructor(
    private readonly defaults: VercelSandboxFactoryOptions = {},
    private readonly createRemote: VercelCreateSandbox = createVercelSandbox
  ) {}

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    validateSourceOptions(this.defaults)
    const env = { ...(this.defaults.env ?? {}), ...(options.env ?? {}) }
    const network = options.network ?? this.defaults.network ?? { mode: "none" }
    const params = buildCreateParams({
      defaults: this.defaults,
      env,
      network,
      name: `${this.defaults.namePrefix ?? DEFAULT_NAME_PREFIX}${randomUUID()}`,
    })

    let client: VercelSandboxClient | undefined
    try {
      client = await this.createRemote(params)
      const sandbox = new VercelSandbox({
        client,
        env,
        timeout: options.timeout ?? this.defaults.timeout,
        workingDirectory: options.workingDirectory,
      })
      await ensureWorkingDirectory({
        client,
        workingDirectory: sandbox.workingDirectory,
        setupTimeoutMs: this.defaults.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
      })
      return sandbox
    } catch (error) {
      await client?.delete().catch(() => {})
      if (error instanceof SandboxError) {
        throw error
      }
      throw new SandboxError(`[Sandbox] vercel create failed: ${errorMessage(error)}`)
    }
  }
}

function buildCreateParams(input: {
  readonly defaults: VercelSandboxFactoryOptions
  readonly env: Readonly<Record<string, string>>
  readonly network: SandboxNetworkPolicy
  readonly name: string
}): VercelCreateSandboxParams {
  const { defaults } = input
  const credentials = resolveCredentials(defaults.credentials)
  const base: Record<string, unknown> = {
    name: input.name,
    env: input.env,
    networkPolicy: toVercelNetworkPolicy(input.network),
    persistent: defaults.persistent ?? false,
    ...(defaults.ports !== undefined ? { ports: [...defaults.ports] } : {}),
    ...(defaults.sessionTimeoutMs !== undefined ? { timeout: defaults.sessionTimeoutMs } : {}),
    ...(defaults.resources !== undefined ? { resources: defaults.resources } : {}),
    ...(defaults.tags !== undefined ? { tags: defaults.tags } : {}),
    ...(defaults.snapshotExpiration !== undefined
      ? { snapshotExpiration: defaults.snapshotExpiration }
      : {}),
    ...(defaults.keepLastSnapshots !== undefined
      ? { keepLastSnapshots: defaults.keepLastSnapshots }
      : {}),
    ...credentials,
  }

  if (defaults.snapshotId !== undefined) {
    return {
      ...base,
      source: { type: "snapshot", snapshotId: defaults.snapshotId },
    } as VercelCreateSandboxParams
  }

  return {
    ...base,
    ...(defaults.source !== undefined ? { source: normalizeSource(defaults.source) } : {}),
    ...(defaults.image !== undefined
      ? { image: defaults.image }
      : { runtime: defaults.runtime ?? DEFAULT_VERCEL_SANDBOX_RUNTIME }),
  } as VercelCreateSandboxParams
}

function normalizeSource(source: VercelSandboxSource): Record<string, unknown> {
  if (source.type === "tarball") {
    return { type: "tarball", url: source.url }
  }
  return {
    type: "git",
    url: source.url,
    ...(source.username !== undefined ? { username: source.username } : {}),
    ...(source.password !== undefined ? { password: source.password } : {}),
    ...(source.depth !== undefined ? { depth: source.depth } : {}),
    ...(source.revision !== undefined ? { revision: source.revision } : {}),
  }
}

function validateSourceOptions(options: VercelSandboxFactoryOptions): void {
  if (options.snapshotId === undefined) {
    return
  }
  const conflicts = [
    options.image !== undefined ? "image" : undefined,
    options.source !== undefined ? "source" : undefined,
    options.runtime !== undefined ? "runtime" : undefined,
  ].filter((value): value is string => value !== undefined)
  if (conflicts.length > 0) {
    throw new SandboxError(
      `[Sandbox] Vercel snapshotId cannot be combined with ${conflicts.join(", ")}.`
    )
  }
}

function resolveCredentials(
  credentials: VercelSandboxCredentials | undefined
): Partial<VercelSandboxCredentials> {
  if (credentials === undefined) {
    return {}
  }
  if (!credentials.token || !credentials.teamId || !credentials.projectId) {
    throw new SandboxError(
      "[Sandbox] Vercel sandbox credentials require token, teamId, and projectId. Omit credentials to let the Vercel SDK resolve OIDC/env credentials."
    )
  }
  return credentials
}

async function ensureWorkingDirectory(input: {
  readonly client: VercelSandboxClient
  readonly workingDirectory: string
  readonly setupTimeoutMs: number
}): Promise<void> {
  const defaultCwd = input.client.cwd ?? "/vercel/sandbox"
  if (input.workingDirectory === defaultCwd) {
    return
  }

  const command = await input.client.runCommand({
    cmd: "mkdir",
    args: ["-p", input.workingDirectory],
    cwd: "/",
    env: {},
    detached: true,
    timeoutMs: input.setupTimeoutMs,
  })
  const finished = await command.wait()
  if (finished.exitCode !== 0) {
    throw new SandboxError(
      `[Sandbox] vercel working directory setup failed: ${await safeStderr(finished)}`
    )
  }
}

async function safeStderr(finished: VercelCommandFinishedClient): Promise<string> {
  try {
    const stderr = await finished.stderr()
    return stderr.trim() || `exit ${finished.exitCode}`
  } catch {
    return `exit ${finished.exitCode}`
  }
}

async function createVercelSandbox(
  params: VercelCreateSandboxParams
): Promise<VercelSandboxClient> {
  const sandbox = await VercelSdkSandbox.create(params)
  return sandbox as unknown as VercelSandboxClient
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
