import { isJsonObject, type JsonObject } from "@sixb/core/models"

export function object(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}
