import type { ObjectRow } from "@sixb/core/storage"
import { toIsoString } from "./http"

/** Canonical JSON representation shared by normal and shared object reads. */
export function serializeObject(row: ObjectRow) {
  return {
    primaryId: row.primaryId,
    objectTypeId: row.objectTypeId,
    properties: row.properties,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  }
}
