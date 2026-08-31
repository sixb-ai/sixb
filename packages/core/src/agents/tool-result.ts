import { isFileRef } from "../blob-storage/validation"
import { isPlainRecord } from "../json"
import type { AgentToolResult } from "./types"

/** Narrow a durable JSON tool output to Sixb's file-aware result envelope. */
export function isAgentToolResult(value: unknown): value is AgentToolResult {
  return (
    isPlainRecord(value) &&
    value.kind === "agentToolResult" &&
    getInvalidAgentToolResultReason(value) === undefined
  )
}

/** Return a precise path when a tagged result does not satisfy the public rich-result contract. */
export function getInvalidAgentToolResultReason(value: unknown): string | undefined {
  if (!isPlainRecord(value) || value.kind !== "agentToolResult") {
    return undefined
  }

  if (!Array.isArray(value.content)) {
    return "result.content must be an array"
  }
  const unsupportedKey = Object.keys(value).find((key) => key !== "kind" && key !== "content")
  if (unsupportedKey) {
    return `result.${unsupportedKey} is not supported`
  }
  if (value.content.length === 0) {
    return "result.content must contain at least one content part"
  }

  for (let index = 0; index < value.content.length; index += 1) {
    const part = value.content[index]
    const path = `result.content[${index}]`
    if (!isPlainRecord(part)) {
      return `${path} must be a text or file content part`
    }
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        return `${path}.text must be a string`
      }
      const unsupportedKey = Object.keys(part).find((key) => key !== "type" && key !== "text")
      if (unsupportedKey) {
        return `${path}.${unsupportedKey} is not supported`
      }
      continue
    }
    if (part.type === "file") {
      if (!isFileRef(part.fileRef)) {
        return `${path}.fileRef must be a valid FileRef`
      }
      const unsupportedKey = Object.keys(part).find((key) => key !== "type" && key !== "fileRef")
      if (unsupportedKey) {
        return `${path}.${unsupportedKey} is not supported`
      }
      continue
    }
    return `${path}.type must be 'text' or 'file'`
  }

  return undefined
}
