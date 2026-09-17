import { MaterializationValidationError } from "../../materialization/errors"
import { sha256Canonical } from "../../materialization/identity"
import type { ObjectVectorSearchProfile } from "../../ontology/types"

export const MAX_VECTOR_K = 1000
export const VECTOR_INPUT_VERSION = 1

export function vectorConfiguration(profile: ObjectVectorSearchProfile): string {
  return sha256Canonical({
    format: VECTOR_INPUT_VERSION,
    sources: [...profile.source],
    provider: profile.model.providerId,
    model: profile.model.modelId,
    dimensions: profile.model.definition.dimensions,
    metric: "cosine",
    precision: "float32",
    normalization: "l2-v1",
  })
}

export function vectorSources(
  source: readonly string[],
  properties: Readonly<Record<string, unknown>>
) {
  const values: Record<string, string | null> = Object.create(null)
  for (const key of source) {
    const value = properties[key]
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new MaterializationValidationError(`Vector source must be text: ${key}`)
    }
    values[key] = typeof value === "string" ? value : null
  }
  // Ordered JSON pairs preserve field boundaries, escaping and absent/empty distinction.
  const text = JSON.stringify(source.map((key) => [key, values[key]]))
  return { text, sourceFingerprint: sha256Canonical(text) }
}

/** Unit-length float32 representation keeps native cosine arithmetic within range. */
export function normalizeVector(values: readonly number[], dimensions: number): readonly number[] {
  if (!Array.isArray(values) || values.length !== dimensions) {
    throw new MaterializationValidationError(`Vector dimension mismatch; expected ${dimensions}`)
  }
  const normalized = Array.from(values, (value) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isFinite(Math.fround(value))
    ) {
      throw new MaterializationValidationError("Vector values must be finite float32 numbers.")
    }
    return Math.fround(value)
  })
  if (!normalized.some((value) => value !== 0)) {
    throw new MaterializationValidationError("Cosine search requires a nonzero vector.")
  }
  const norm = Math.hypot(...normalized)
  return Object.freeze(normalized.map((value) => Math.fround(value / norm)))
}

/** V1 envelope for exact SQL scoring; exceeding it must fail rather than truncate candidates. */
export function vectorSearchCandidateLimit(dimensions: number): number {
  return Math.min(10000, Math.floor(16000000 / dimensions))
}
