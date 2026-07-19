import type { MaterializationStateRequestChunk } from "../storage/ontology"
import type { OntologyEditOperation, OntologyObjectRef } from "./types"

export function stateRequestForOperation(
  operation: OntologyEditOperation
): MaterializationStateRequestChunk {
  if (
    operation.kind === "object.create" ||
    operation.kind === "object.upsert" ||
    operation.kind === "object.patch" ||
    operation.kind === "object.delete" ||
    operation.kind === "object.restore"
  ) {
    return {
      objects: [operation.ref as OntologyObjectRef],
      links: [],
      linkScopes: [],
      // Incident authority is needed only when the ordered operation changes effective presence.
      incidentObjects: [],
      points: [],
    }
  }
  const ref = operation.ref as import("./types").OntologyLinkRef
  return {
    objects: [ref.source, ref.target],
    links: [ref],
    linkScopes: [{ source: ref.source, linkId: ref.linkId }],
    incidentObjects: [],
    points: [],
  }
}

export async function* oneStateRequest(
  request: MaterializationStateRequestChunk
): AsyncIterable<MaterializationStateRequestChunk> {
  yield request
}
