import { isJsonObject, type JsonObject } from "@sixb/core/models"

export const PREFIX = "[SixbAzureAIFoundry]"

export function object(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

export function positiveInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${PREFIX} ${field} must be a positive safe integer.`)
  }
}
export function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
