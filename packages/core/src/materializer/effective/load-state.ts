import type {
  MaterializationLinkScopeState,
  MaterializationLinkState,
  MaterializationObjectState,
  MaterializationSession,
  MaterializationStatePage,
  MaterializationStateRequestChunk,
  OntologyMaterializationStorage,
  StoredTelemetryPoint,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"

interface MutableStatePage {
  objects: MaterializationObjectState[]
  links: MaterializationLinkState[]
  linkScopes: MaterializationLinkScopeState[]
  points: StoredTelemetryPoint[]
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
