import type { Principal } from "../auth/types"

/** User or service account that may initiate or authorize an execution. */
export type AuthorizablePrincipal = Extract<Principal, { readonly type: "user" | "serviceAccount" }>

/** Registered primitive kinds that may receive internal trusted authority. */
export type TrustedPrimitiveKind =
  | "action"
  | "pipeline"
  | "projection"
  | "rule"
  | "sync"
  | "webhook"
  | "workflow"

export interface TrustedPrimitiveRef {
  readonly kind: TrustedPrimitiveKind
  readonly id: string
  readonly runId: string
}

export type KernelOperation = {
  readonly type: "ontology.recover"
  readonly recoveryId: string
}

/** Workload currently executing. This is provenance and never grants authority by itself. */
export type ExecutionExecutor =
  | { readonly type: "request"; readonly requestId: string }
  | {
      readonly type: "primitive"
      readonly kind: TrustedPrimitiveKind
      readonly id: string
      readonly runId: string
    }
  | { readonly type: "agent"; readonly agentId: string; readonly runId: string }
  | { readonly type: "kernel"; readonly operation: KernelOperation }

/**
 * Occurrence that directly triggered an execution.
 *
 * The `queue` source is transitional until workers restore durable execution authority.
 */
export type ExecutionSource =
  | { readonly type: "http"; readonly requestId: string }
  | { readonly type: "webhook"; readonly deliveryId: string }
  | { readonly type: "schedule"; readonly eventId: string }
  | { readonly type: "event"; readonly eventId: string }
  | { readonly type: "execution"; readonly executionId: string }
  | { readonly type: "queue"; readonly queue: string; readonly jobId: string }

/** Immutable provenance for one request, primitive run, agent run, or kernel operation. */
export interface ExecutionContext {
  readonly id: string
  readonly projectId: string
  readonly requestedBy?: AuthorizablePrincipal
  readonly executor: ExecutionExecutor
  readonly source: ExecutionSource
  readonly correlationId: string
  readonly parentExecutionId?: string
}

/** Durable descriptor used to rebuild authority. A reference is never authoritative by itself. */
export type AuthorizationRef =
  | {
      readonly type: "principal"
      readonly principal: AuthorizablePrincipal
      readonly credential?:
        | { readonly type: "session"; readonly id: string }
        | { readonly type: "accessToken"; readonly id: string }
    }
  | { readonly type: "trustedPrimitive"; readonly primitive: TrustedPrimitiveRef }
  | { readonly type: "kernel"; readonly operation: KernelOperation }
  | { readonly type: "disabled" }

class RuntimeAuthorizationCapability {
  readonly #runtimeAuthorization = true

  private constructor() {}

  static create(): RuntimeAuthorizationCapability {
    const capability = new RuntimeAuthorizationCapability()
    Object.freeze(capability)
    return capability
  }

  static is(value: unknown): value is RuntimeAuthorizationCapability {
    return typeof value === "object" && value !== null && #runtimeAuthorization in value
  }
}

/**
 * Opaque, process-local authority.
 *
 * The private class makes it nominal in TypeScript; Core registry membership makes it authoritative
 * at runtime. The capability itself is never persisted.
 */
export type RuntimeAuthorization = RuntimeAuthorizationCapability

/** Execution provenance paired with the process-local authority that permits its operations. */
export interface ExecutionScope {
  readonly execution: ExecutionContext
  readonly authorization: RuntimeAuthorization
}

/** Internal constructor; the package root exports only the opaque type. */
export function createRuntimeAuthorizationCapability(): RuntimeAuthorization {
  return RuntimeAuthorizationCapability.create()
}

/** Internal runtime guard; registry membership remains the source of authority. */
export function isRuntimeAuthorizationCapability(value: unknown): value is RuntimeAuthorization {
  return RuntimeAuthorizationCapability.is(value)
}
