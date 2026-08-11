import type { AuthorizationContext } from "../authorization"
import { assertRuntimeAuthorizationBound } from "../authorization/decision"
import type { BlobsRuntime } from "../blob-storage"
import type { ConnectorRuntime } from "../connectors"
import type { OntologySource } from "../ontology"
import { isBoundSixb, type Sixb } from "../runtime/sixb"
import { createAgentScope } from "./scopes"
import type { AuthorizablePrincipal, ExecutionScope, ExecutionSource } from "./types"

/** Minimal host boundary required by agent workers. */
export interface AgentExecutionHost {
  readonly id: string
  readonly blobs: BlobsRuntime
  readonly connector: ConnectorRuntime
  withScope(scope: ExecutionScope): object
}

export interface BoundAgentExecution {
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly blobs: Omit<BlobsRuntime, "close">
  readonly connector: ConnectorRuntime
}

export interface BindAgentExecutionInput {
  readonly agentId: string
  readonly runId: string
  readonly authorization: AuthorizationContext
  readonly source: ExecutionSource
  readonly requestedBy?: AuthorizablePrincipal
  readonly correlationId?: string
  readonly parentExecutionId?: string
}

/** Bind one agent service account's resolved grants to the claimed run. */
export function bindAgentExecution(
  host: AgentExecutionHost,
  input: BindAgentExecutionInput
): BoundAgentExecution {
  const scope = createAgentScope({
    projectId: host.id,
    agentId: input.agentId,
    runId: input.runId,
    context: input.authorization,
    source: input.source,
    ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: input.parentExecutionId }),
  })
  const assertAgentAccess = () => {
    const authorization = assertRuntimeAuthorizationBound({
      runtimeAuthorization: scope.authorization,
    })
    if (authorization.type !== "principal" || scope.execution.executor.type !== "agent") {
      throw new Error("[Sixb] Agent provider access requires a bound agent execution.")
    }
  }

  const sixb = host.withScope(scope)
  if (!isBoundSixb(sixb)) {
    throw new Error("[Sixb] Agent execution host returned an invalid bound SDK.")
  }
  const connector: ConnectorRuntime = (definition) => {
    assertAgentAccess()
    return host.connector(definition)
  }
  const bound: BoundAgentExecution = {
    sixb,
    blobs: bindAgentBlobs(host.blobs, assertAgentAccess),
    connector,
  }
  return Object.freeze(bound)
}

function bindAgentBlobs(
  blobs: BlobsRuntime,
  assertAgentAccess: () => void
): Omit<BlobsRuntime, "close"> {
  const bound: Omit<BlobsRuntime, "close"> = {
    put: (input) => {
      assertAgentAccess()
      return blobs.put(input)
    },
    open: (blobId) => {
      assertAgentAccess()
      return blobs.open(blobId)
    },
    stat: (blobId) => {
      assertAgentAccess()
      return blobs.stat(blobId)
    },
  }

  const openRange = blobs.openRange?.bind(blobs)
  if (openRange) {
    bound.openRange = (blobId, range) => {
      assertAgentAccess()
      return openRange(blobId, range)
    }
  }
  const createUpload = blobs.createUpload?.bind(blobs)
  if (createUpload) {
    bound.createUpload = (upload) => {
      assertAgentAccess()
      return createUpload(upload)
    }
  }
  const signUploadPart = blobs.signUploadPart?.bind(blobs)
  if (signUploadPart) {
    bound.signUploadPart = (part) => {
      assertAgentAccess()
      return signUploadPart(part)
    }
  }
  const completeUpload = blobs.completeUpload?.bind(blobs)
  if (completeUpload) {
    bound.completeUpload = (upload) => {
      assertAgentAccess()
      return completeUpload(upload)
    }
  }
  const abortUpload = blobs.abortUpload?.bind(blobs)
  if (abortUpload) {
    bound.abortUpload = (upload) => {
      assertAgentAccess()
      return abortUpload(upload)
    }
  }
  return Object.freeze(bound)
}
