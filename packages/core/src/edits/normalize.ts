import type { OntologyEditOperation } from "../materialization/model"
import { EditBatchError } from "./errors"
import type { EditBatch, EditObjectRef, EditOperation } from "./types"

/**
 * Lowers an authored batch onto the canonical Materializer operation union.
 *
 * This is a mechanical translation. The recorder validates what a handler authored, and the
 * Materializer validates refs, property values, and Ontology semantics when it commits, so nothing
 * is re-checked here.
 *
 * Operation ids carry the authoring ordinal, so repeated operations on one entity keep their
 * sequence and every outcome maps back to the operation that produced it.
 */
export function lowerEditBatch(batch: EditBatch): readonly OntologyEditOperation[] {
  return batch.operations.map((operation, index) => lowerEditOperation(operation, `op:${index}`))
}

function lowerEditOperation(operation: EditOperation, id: string): OntologyEditOperation {
  switch (operation.kind) {
    case "object.create":
      return {
        id,
        kind: "object.create",
        ref: objectRef(operation),
        properties: operation.properties,
      }
    case "object.update":
      return {
        id,
        kind: "object.patch",
        ref: objectRef(operation),
        set: operation.properties,
        unset: [],
        reset: [],
      }
    case "object.unset":
      return {
        id,
        kind: "object.patch",
        ref: objectRef(operation),
        set: {},
        unset: operation.propertyIds,
        reset: [],
      }
    case "object.reset":
      return {
        id,
        kind: "object.patch",
        ref: objectRef(operation),
        set: {},
        unset: [],
        reset: operation.propertyIds,
      }
    case "object.delete":
      return { id, kind: "object.delete", ref: objectRef(operation) }
    case "object.restore":
      return { id, kind: "object.restore", ref: objectRef(operation) }
    case "link.upsert":
      return {
        id,
        kind: "link.upsert",
        ref: linkRef(operation),
        ...(operation.properties !== undefined ? { properties: operation.properties } : {}),
      }
    case "link.delete":
      return { id, kind: "link.delete", ref: linkRef(operation) }
    case "link.reset":
      return { id, kind: "link.reset", ref: linkRef(operation) }
    default:
      throw new EditBatchError(
        `[Sixb] Unknown EditBatch operation kind '${String((operation as { kind?: unknown }).kind)}'.`
      )
  }
}

function objectRef(operation: { objectTypeId: string; primaryId: string }) {
  return { objectTypeId: operation.objectTypeId, primaryId: operation.primaryId }
}

function linkRef(operation: { source: EditObjectRef; linkId: string; target: EditObjectRef }) {
  return {
    source: objectRef(operation.source),
    linkId: operation.linkId,
    target: objectRef(operation.target),
  }
}
