import type {
  MaterializationLinkScopeState,
  MaterializationLinkState,
  MaterializationObjectState,
  MaterializationSession,
  MaterializationStatePage,
  MaterializationStateRequestChunk,
  OntologyMaterializationStorage,
  StoredTelemetryPoint,
} from "../storage/ontology"
import type { MaterializerContext } from "./materializer-context"
import type { OntologyEditOperation } from "./types"

interface MutableStatePage {
  objects: MaterializationObjectState[]
  links: MaterializationLinkState[]
  linkScopes: MaterializationLinkScopeState[]
  points: StoredTelemetryPoint[]
}

export function stateRequestForOperation(
  operation: OntologyEditOperation
): MaterializationStateRequestChunk {
  switch (operation.kind) {
    case "object.create":
    case "object.upsert":
    case "object.patch":
    case "object.delete":
    case "object.restore":
      return {
        objects: [operation.ref],
        links: [],
        linkScopes: [],
        // Incident authority is needed only when the ordered operation changes effective presence.
        incidentObjects: [],
        points: [],
      }
    case "link.upsert":
    case "link.delete":
    case "link.reset":
      return {
        objects: [operation.ref.source, operation.ref.target],
        links: [operation.ref],
        linkScopes: [{ source: operation.ref.source, linkId: operation.ref.linkId }],
        incidentObjects: [],
        points: [],
      }
  }
}

export async function* oneStateRequest(
  request: MaterializationStateRequestChunk
): AsyncIterable<MaterializationStateRequestChunk> {
  yield request
}

export async function loadState(
  context: Pick<MaterializerContext, "batching">,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  request: MaterializationStateRequestChunk
): Promise<MaterializationStatePage> {
  const result: MutableStatePage = { objects: [], links: [], linkScopes: [], points: [] }
  for await (const page of storage.streamState({
    session,
    requests: oneStateRequest(request),
    pageRows: context.batching.statePageRows,
  })) {
    result.objects.push(...page.objects)
    result.links.push(...page.links)
    result.linkScopes.push(...page.linkScopes)
    result.points.push(...page.points)
  }
  return result
}
