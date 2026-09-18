import { DefaultAzureCredential } from "@azure/identity"
import { SandboxError } from "@sixb/core/sandboxes"
import type { AzureSandboxFactoryOptions } from "./options"

const API_VERSION = "2026-02-01-preview"
const TOKEN_SCOPE = "https://dynamicsessions.io/.default"
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Internal wire types. Policy translation and lifecycle polling belong to the provider. */
export interface AzureEgressPolicy {
  readonly defaultAction: "Allow" | "Deny"
  readonly trafficInspection: "Full" | "None"
  readonly hostRules: readonly { readonly pattern: string; readonly action: "Allow" | "Deny" }[]
}

export interface AzureCreateRequest {
  readonly sourcesRef: {
    readonly diskImage: { readonly name: string; readonly isPublic: true } | { readonly id: string }
  }
  readonly resources?: { readonly cpu: string; readonly memory: string; readonly disk: string }
  readonly egressPolicy: AzureEgressPolicy
  readonly labels?: Readonly<Record<string, string>>
  readonly lifecycle?: {
    readonly autoSuspend: {
      readonly enabled: boolean
      readonly interval?: number
      readonly mode: "Disk"
    }
    readonly autoDelete: { readonly enabled: boolean; readonly deleteIntervalSeconds?: number }
  }
}

export interface AzureSandboxResource {
  readonly id: string
  /** Preserve unknown states so the session layer can fail closed. */
  readonly state: string
}

export interface AzureExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface AzureRequestOptions {
  /** Cancels the HTTP request only; it does not terminate a guest command. */
  readonly signal?: AbortSignal
}

/** Small replaceable transport seam. Mutations return acceptance, not lifecycle completion. */
export interface AzureSandboxClient {
  create(body: AzureCreateRequest, options?: AzureRequestOptions): Promise<AzureSandboxResource>
  get(id: string, options?: AzureRequestOptions): Promise<AzureSandboxResource>
  execute(
    id: string,
    command: string,
    cwd: string,
    options?: AzureRequestOptions
  ): Promise<AzureExecResult>
  writeFile(
    id: string,
    path: string,
    contents: string | Uint8Array,
    mode?: number,
    options?: AzureRequestOptions
  ): Promise<void>
  setEgressPolicy(
    id: string,
    policy: AzureEgressPolicy,
    options?: AzureRequestOptions
  ): Promise<void>
  stop(id: string, options?: AzureRequestOptions): Promise<void>
  delete(id: string, options?: AzureRequestOptions): Promise<void>
}

type FailureKind = "http" | "timeout" | "aborted" | "authentication" | "transport" | "response"

/** No service body, command, URL, or credential is included in errors exposed to callers. */
export class AzureSandboxRequestError extends SandboxError {
  constructor(
    readonly operation: string,
    readonly kind: FailureKind,
    readonly statusCode?: number
  ) {
    super(
      `[Sandbox] Azure ${operation} failed (${kind}${statusCode === undefined ? "" : ` ${statusCode}`}).`
    )
  }
}

type ClientOptions = Pick<
  AzureSandboxFactoryOptions,
  "subscriptionId" | "resourceGroup" | "sandboxGroup" | "region" | "credential" | "requestTimeoutMs"
>
type Fetch = (url: URL, init: RequestInit) => Promise<Response>

interface Request {
  readonly operation: string
  readonly method: "GET" | "PUT" | "POST" | "DELETE"
  readonly path: string
  readonly success: readonly number[]
  readonly body?: BodyInit
  readonly contentType?: string
  readonly response?: "json"
  readonly query?: Record<string, string>
}

/**
 * Direct data-plane requests avoid preview SDK methods that discard abort/deadline options.
 * There are deliberately no retries: create and execute may have succeeded despite a lost reply.
 * Only public Azure endpoints are supported; tokens must never follow a redirect.
 */
export function createAzureSandboxClient(
  options: ClientOptions,
  dependencies: { readonly fetch?: Fetch } = {}
): AzureSandboxClient {
  if (!/^[a-z][a-z0-9]*$/.test(options.region)) {
    throw new SandboxError("[Sandbox] Azure region must be a public-cloud region identifier.")
  }
  const segments = [options.subscriptionId, options.resourceGroup, options.sandboxGroup]
  if (
    segments.some(
      (value) =>
        !value ||
        value === "." ||
        value === ".." ||
        value.trim() !== value ||
        /[/\\?#\u0000-\u001f]/.test(value)
    )
  ) {
    throw new SandboxError(
      "[Sandbox] Azure subscription, resource group and sandbox group are required path segments."
    )
  }
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new SandboxError("[Sandbox] Azure requestTimeoutMs must be a positive 32-bit integer.")
  }
  const credential = options.credential ?? new DefaultAzureCredential()
  const fetchRequest = dependencies.fetch ?? fetch
  const [subscription, resourceGroup, sandboxGroup] = segments.map(encodeURIComponent)
  const base = `https://management.${options.region}.azuredevcompute.io/subscriptions/${subscription}/resourceGroups/${resourceGroup}/sandboxGroups/${sandboxGroup}/sandboxes`

  async function request(
    input: Request,
    requestOptions: AzureRequestOptions = {}
  ): Promise<unknown> {
    const { operation } = input
    const controller = new AbortController()
    const aborted = () => controller.abort(new AzureSandboxRequestError(operation, "aborted"))
    if (requestOptions.signal?.aborted) aborted()
    else requestOptions.signal?.addEventListener("abort", aborted, { once: true })
    const timer = setTimeout(
      () => controller.abort(new AzureSandboxRequestError(operation, "timeout")),
      timeoutMs
    )
    let rejectAbort: (() => void) | undefined
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason)
      if (controller.signal.aborted) rejectAbort()
      else controller.signal.addEventListener("abort", rejectAbort, { once: true })
    })
    let phase: FailureKind = "authentication"
    try {
      return await Promise.race([
        interrupted,
        (async () => {
          controller.signal.throwIfAborted()
          const token = await credential.getToken(TOKEN_SCOPE, { abortSignal: controller.signal })
          controller.signal.throwIfAborted()
          if (!token?.token) throw new AzureSandboxRequestError(operation, "authentication")
          phase = "transport"
          const url = new URL(`${base}${input.path}`)
          url.search = new URLSearchParams({
            "api-version": API_VERSION,
            ...input.query,
          }).toString()
          const response = await fetchRequest(url, {
            method: input.method,
            headers: {
              Authorization: `Bearer ${token.token}`,
              "Content-Type": input.contentType ?? "application/json",
              Accept: "application/json",
            },
            body: input.body,
            signal: controller.signal,
            redirect: "manual",
          })
          if (!input.success.includes(response.status)) {
            await response.body?.cancel()
            throw new AzureSandboxRequestError(operation, "http", response.status)
          }
          phase = "response"
          if (input.response !== "json") {
            await response.body?.cancel()
            return undefined
          }
          return await response.json()
        })(),
      ])
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      if (error instanceof AzureSandboxRequestError) throw error
      throw new AzureSandboxRequestError(operation, phase)
    } finally {
      clearTimeout(timer)
      requestOptions.signal?.removeEventListener("abort", aborted)
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort)
    }
  }

  const sandboxPath = (id: string) => {
    if (!id || id === "." || id === "..")
      throw new SandboxError("[Sandbox] Azure sandbox id is required.")
    return `/${encodeURIComponent(id)}`
  }
  const json = (value: unknown) => JSON.stringify(value)
  return {
    create: async (body, opts) =>
      parseSandbox(
        await request(
          {
            operation: "create",
            method: "PUT",
            path: "",
            success: [200, 201],
            body: json(body),
            response: "json",
          },
          opts
        ),
        "create"
      ),
    get: async (id, opts) =>
      parseSandbox(
        await request(
          {
            operation: "get",
            method: "GET",
            path: sandboxPath(id),
            success: [200],
            response: "json",
          },
          opts
        ),
        "get"
      ),
    execute: async (id, command, cwd, opts) => {
      const result = await request(
        {
          operation: "execute",
          method: "POST",
          path: `${sandboxPath(id)}/executeShellCommand`,
          success: [200],
          body: json({ command, workingDirectory: cwd }),
          response: "json",
        },
        opts
      )
      if (
        !isRecord(result) ||
        !Number.isInteger(result.exitCode) ||
        typeof result.exitCode !== "number" ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string"
      ) {
        throw new AzureSandboxRequestError("execute", "response")
      }
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    },
    writeFile: async (id, path, contents, mode, opts) => {
      await request(
        {
          operation: "write file",
          method: "PUT",
          path: `${sandboxPath(id)}/files`,
          success: [200, 201, 204],
          body:
            typeof contents === "string"
              ? new TextEncoder().encode(contents)
              : new Uint8Array(contents),
          contentType: "application/octet-stream",
          query: {
            path,
            createDirs: "true",
            ...(mode === undefined ? {} : { mode: String(mode) }),
          },
        },
        opts
      )
    },
    setEgressPolicy: async (id, policy, opts) => {
      await request(
        {
          operation: "set egress",
          method: "POST",
          path: `${sandboxPath(id)}/egresspolicy`,
          success: [200, 201],
          body: json(policy),
        },
        opts
      )
    },
    stop: async (id, opts) => {
      await request(
        {
          operation: "stop",
          method: "POST",
          path: `${sandboxPath(id)}/stop`,
          success: [200, 202, 204],
          body: "{}",
        },
        opts
      )
    },
    delete: async (id, opts) => {
      await request(
        {
          operation: "delete",
          method: "DELETE",
          path: sandboxPath(id),
          success: [200, 202, 204, 404],
        },
        opts
      )
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseSandbox(value: unknown, operation: string): AzureSandboxResource {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.state !== "string" ||
    !value.state
  ) {
    throw new AzureSandboxRequestError(operation, "response")
  }
  return { id: value.id, state: value.state }
}
