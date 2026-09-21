import { isPlainRecord } from "../json"
import type { OntologyRegistry } from "../ontology/registry"
import { assertValidSchema } from "../ontology/validation/definition"
import type { Sixb } from "../runtime/sixb"
import type { InferParams, ParamsConfig } from "../shared/params/types"
import { coerceParamsToTyped, normalizeParams } from "../shared/params/validation"
import { SandboxError } from "./errors"
import type { SandboxNetworkPolicy } from "./sandbox"

/** Static recipes accept an empty parameter record, not arbitrary undeclared keys. */
export type InferSandboxParams<TParams extends ParamsConfig> = keyof TParams extends never
  ? Record<string, never>
  : InferParams<TParams>

/** Initial project contents, independent from the provider's runtime image or saved state. */
export interface SandboxSource {
  readonly type: "git"
  readonly url: string
  readonly revision?: string
  readonly access?: "read" | "write"
}

/** Host-side recipe. Environment values are guest-readable, never a Git credential channel. */
export interface SandboxEnvironment {
  readonly source?: SandboxSource
  readonly setup?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly network?: SandboxNetworkPolicy
}

export interface SandboxResolveContext<TParams = Record<string, unknown>> {
  readonly params: TParams
  /** Bound to the current execution; a stored binding is not authorization. */
  readonly sixb: Sixb
}

// The recipe both declares and consumes this schema: keep it invariant instead of asking
// TypeScript to compare the recursive ontology inference through callback variance.
export interface SandboxConfig<in out TParams extends ParamsConfig = ParamsConfig>
  extends SandboxEnvironment {
  readonly params?: TParams
  readonly resolve?: (
    context: SandboxResolveContext<InferParams<NoInfer<TParams>>>
  ) => SandboxEnvironment | Promise<SandboxEnvironment>
}

/** Registered project recipe; only thread params cross the durable boundary. */
export interface SandboxDefinition {
  readonly params: ParamsConfig
  readonly resolve: (context: SandboxResolveContext) => Promise<SandboxEnvironment>
}

export function createSandboxDefinition<TParams extends ParamsConfig>(
  config: SandboxConfig<TParams>,
  ontology: OntologyRegistry
): SandboxDefinition {
  const raw: unknown = config
  if (
    !isPlainRecord(raw) ||
    (config.params !== undefined && !isPlainRecord(raw.params)) ||
    (config.resolve !== undefined && typeof config.resolve !== "function")
  ) {
    throw new SandboxError(
      "[Sixb] Sandbox configuration requires a params object and a callable resolver when provided."
    )
  }
  for (const key of Object.keys(config)) {
    if (!["params", "resolve", "source", "setup", "env", "network"].includes(key)) {
      throw new SandboxError("[Sixb] Unknown sandbox configuration field.")
    }
  }
  if (config.params !== undefined && config.resolve === undefined) {
    throw new SandboxError("[Sixb] Sandbox params require a resolve function.")
  }
  if (config.resolve !== undefined && (config.source !== undefined || config.setup !== undefined)) {
    throw new SandboxError("[Sixb] Use either static source/setup or resolve, not both.")
  }
  const invalid = (path: string) =>
    new SandboxError(`[Sixb] ${path} must be a valid parameter declaration; use param(schema).`)
  for (const [id, value] of Object.entries(config.params ?? {})) {
    const path = `sandboxes.params.${id}`
    if (!id.trim() || !isPlainRecord(value)) throw invalid(path)
    for (const key of Object.keys(value)) {
      if (!["schema", "required", "nullable", "description", "semanticType"].includes(key)) {
        throw invalid(path)
      }
    }
    if (
      (value.required !== undefined && typeof value.required !== "boolean") ||
      (value.nullable !== undefined && typeof value.nullable !== "boolean") ||
      (value.description !== undefined && typeof value.description !== "string") ||
      (value.semanticType !== undefined && typeof value.semanticType !== "string")
    )
      throw invalid(path)
    const schema: unknown = value.schema
    if (isPlainRecord(schema) && schema.type === "objectRef") {
      if (
        typeof schema.objectTypeId !== "string" ||
        !ontology.getObjectTypesById().has(schema.objectTypeId)
      ) {
        throw invalid(path)
      }
    } else {
      assertValidSchema(schema, `${path}.schema`, invalid)
    }
  }
  const params = structuredClone(config.params ?? {}) as ParamsConfig
  const environment = captureEnvironment({
    ...(config.source === undefined ? {} : { source: config.source }),
    ...(config.setup === undefined ? {} : { setup: config.setup }),
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.network === undefined ? {} : { network: config.network }),
  })
  // Capture the function too: later mutation of application config must not change this host.
  // Erase inference only after capturing its schema; every invocation validates and coerces below.
  const resolve = config.resolve as SandboxConfig["resolve"]
  deepFreeze(params)
  return Object.freeze({
    params,
    resolve: async ({ params: input, sixb }: SandboxResolveContext) => {
      const binding = normalizeParams(ontology.getValueTypesById(), params, input, {
        kind: "sandbox",
        id: "sandboxes",
        path: "sandbox",
      })
      const typed = coerceParamsToTyped(params, binding, ontology.getValueTypesById())
      if (!resolve) return structuredClone(environment)
      const resolved = captureEnvironment(await resolve({ params: typed, sixb }))
      return {
        ...structuredClone(environment),
        ...resolved,
        env: { ...environment.env, ...resolved.env },
      }
    },
  })
}

/** Capture declarative data only; never retain caller-owned objects or include values in errors. */
function captureEnvironment(value: unknown): SandboxEnvironment {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !["source", "setup", "env", "network"].includes(key))
  ) {
    return fail("environment")
  }
  if (value.source !== undefined) validateSource(value.source)
  if (value.setup !== undefined) validateSetup(value.setup)
  if (value.env !== undefined) validateEnv(value.env)
  if (value.network !== undefined) validateNetwork(value.network)
  // Every field and discriminant has been checked above; return only an isolated snapshot.
  return structuredClone(value) as SandboxEnvironment
}

function fail(field: string): never {
  throw new SandboxError(`[Sixb] Invalid sandbox ${field}.`)
}

function validateSource(source: unknown): void {
  if (
    !isPlainRecord(source) ||
    source.type !== "git" ||
    typeof source.url !== "string" ||
    Object.keys(source).some((key) => !["type", "url", "revision", "access"].includes(key))
  ) {
    fail("source")
  }
  const url = parseUrl(source.url, "source URL")
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    fail("source URL: expected credential-free HTTPS")
  }
  if (
    source.revision !== undefined &&
    (typeof source.revision !== "string" ||
      !source.revision.trim() ||
      source.revision.startsWith("-") ||
      /[\x00-\x1f]/.test(source.revision))
  ) {
    fail("source revision")
  }
  if (source.access !== undefined && source.access !== "read" && source.access !== "write") {
    fail("source access")
  }
}

function validateSetup(setup: unknown): void {
  if (
    !Array.isArray(setup) ||
    setup.some(
      (command) => typeof command !== "string" || !command.trim() || command.includes("\0")
    )
  ) {
    fail("setup")
  }
}

function validateEnv(env: unknown): void {
  if (
    !isPlainRecord(env) ||
    Object.entries(env).some(
      ([key, entry]) =>
        !key || /[=\0]/.test(key) || typeof entry !== "string" || entry.includes("\0")
    )
  ) {
    fail("env")
  }
}

function validateNetwork(network: unknown): void {
  if (!isPlainRecord(network)) fail("network")
  if (network.mode === "restricted") {
    if (
      Object.keys(network).some((key) => key !== "mode" && key !== "allow") ||
      !Array.isArray(network.allow)
    ) {
      fail("network")
    }
    for (const target of network.allow) validateNetworkTarget(target)
    return
  }
  if (
    (network.mode !== "none" && network.mode !== "all") ||
    Object.keys(network).some((key) => key !== "mode")
  ) {
    fail("network")
  }
}

function validateNetworkTarget(target: unknown): void {
  if (
    !isPlainRecord(target) ||
    typeof target.name !== "string" ||
    !target.name.trim() ||
    typeof target.origin !== "string" ||
    Object.keys(target).some((key) => key !== "name" && key !== "origin")
  ) {
    fail("network target")
  }
  const url = parseUrl(target.origin, "network origin")
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== target.origin) {
    fail("network origin")
  }
}

function parseUrl(value: string, field: string): URL {
  try {
    return new URL(value)
  } catch {
    return fail(field)
  }
}

function deepFreeze(value: object, seen = new Set<object>()): void {
  if (seen.has(value)) return
  seen.add(value)
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") deepFreeze(child, seen)
  }
  Object.freeze(value)
}
