/**
 * File handle factory for ObjectReadByIdHandle.
 *
 * Opens a `fileRef` property through the object that holds it, the way the object file content
 * route does: the object is read again with the caller's permissions, the FileRef is resolved in
 * that authorized row, then checked against the stored blob before it is opened.
 */
import { AuthorizationError } from "../../authorization/errors"
import { jsonPointerSegment, openFileRef, resolveFileRefAtPath } from "../../blob-storage/internal"
import type { Property } from "../../ontology"
import { OntologyValidationError } from "../../ontology/errors"
import type { PropertyToken } from "../../ontology/tokens"
import { assertPropertyTokenBelongsToObjectType } from "../../ontology/validation"
import type { ObjectFileHandle } from "../../runtime/types"
import type { ObjectSetContext } from "../context"

export function createObjectFileHandle(
  ctx: ObjectSetContext,
  primaryId: string,
  property: PropertyToken<string, string, Property>,
  index?: number
): ObjectFileHandle {
  const { objectType } = ctx
  assertPropertyTokenBelongsToObjectType(objectType, property)
  const registered = ctx.ontology
    .resolveObjectType(objectType.id)
    .properties.find((candidate) => candidate.id === property.id)
  if (!registered) {
    throw new OntologyValidationError(
      `[Sixb] Unknown property '${property.id}' for object type '${objectType.id}'`
    )
  }
  const path = filePropertyPath(objectType.id, registered, index)

  return {
    async open() {
      const row = await ctx.objectReader.getByPrimaryId({ objectTypeId: objectType.id, primaryId })
      if (!row) return null
      if (row.redactions?.[property.id]) {
        // Redacted, so the registered property has a marking the caller is not cleared for.
        const markings = registered.markings ?? []
        const marking =
          markings.find((markingId) => !ctx.authorization?.clearances?.has(markingId)) ??
          markings[0]
        throw new AuthorizationError(
          `clearance:marking:${marking}`,
          `[Sixb] Cannot open file '${objectType.id}.${property.id}': it requires clearance for marking '${marking}'.`
        )
      }
      const fileRef = resolveFileRefAtPath(row, path)
      return fileRef ? openFileRef(ctx.blobStorage, fileRef) : null
    },
  }
}

/** JSON Pointer to the file in an object row, validated against the property's schema. */
function filePropertyPath(objectTypeId: string, property: Property, index: number | undefined) {
  const { schema } = property
  const name = `${objectTypeId}.${property.id}`
  if (schema === "fileRef") {
    if (index !== undefined) {
      throw new OntologyValidationError(`[Sixb] Property ${name} holds one file; omit the index.`)
    }
    return `/properties/${jsonPointerSegment(property.id)}`
  }
  if (typeof schema === "object" && schema.type === "array" && schema.items === "fileRef") {
    if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
      throw new OntologyValidationError(
        `[Sixb] Property ${name} holds a list of files; pass the index of the file to open.`
      )
    }
    return `/properties/${jsonPointerSegment(property.id)}/${index}`
  }
  throw new OntologyValidationError(
    `[Sixb] Property ${name} is not a file: file() takes a "fileRef" property or a list of them.`
  )
}
