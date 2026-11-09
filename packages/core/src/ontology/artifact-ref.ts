import { isArtifactId } from "../artifacts/ids"
import { OntologyValidationError } from "./errors"
import type { Schema } from "./types"

/**
 * Value of a `ref.artifact()` (`"artifactRef"`) schema: one artifact, followed at its latest
 * version.
 *
 * Like a user reference, it carries no title or kind: a writer could make them up, and the
 * artifact keeps its own.
 */
export interface ArtifactRef {
  readonly type: "artifact"
  readonly id: string
}

/**
 * Build a reference to one artifact, for writes and query predicates:
 * `where(({ p }) => p.kickoffDoc.eq(artifactRef("art_k3m9q2x7tp")))`.
 */
export function artifactRef(id: string): ArtifactRef {
  if (typeof id !== "string" || !isArtifactId(id)) {
    throw new OntologyValidationError(
      `[Sixb] Artifact reference id must be an artifact id such as 'art_k3m9q2x7tp', got ${JSON.stringify(id)}.`
    )
  }

  return Object.freeze({ type: "artifact" as const, id })
}

/** Exactly `{ type: "artifact", id }` with an artifact id and no other field. */
export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false

  const record = value as Record<string, unknown>
  return (
    Object.keys(record).every((key) => key === "type" || key === "id") &&
    record.type === "artifact" &&
    typeof record.id === "string" &&
    isArtifactId(record.id)
  )
}

/** A `ref.artifact()` schema, or an array of them. */
export function isArtifactRefPropertySchema(schema: Schema): boolean {
  if (schema === "artifactRef") return true
  return typeof schema === "object" && schema.type === "array" && schema.items === "artifactRef"
}
