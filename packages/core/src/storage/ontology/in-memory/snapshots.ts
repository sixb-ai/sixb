import type { OntologyObjectRef } from "../../../materialization/model"
import type { StoredObjectVector } from "../vectors"
import type { InMemoryOntologyState } from "./shared-state"
import { vectorObjectKey } from "./vectors"

/** What a snapshot reads from the in-memory state beside the object reader. */
export class InMemorySnapshots {
  constructor(private readonly state: InMemoryOntologyState) {}

  readVectors(projectId: string, refs: readonly OntologyObjectRef[]): StoredObjectVector[] {
    return refs.flatMap((ref) => [
      ...(this.state.vectors.get(vectorObjectKey(projectId, ref))?.values() ?? []),
    ])
  }
}
