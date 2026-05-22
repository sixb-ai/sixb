import type { S4DirEntry, S4ReadResult } from "@s4/core"
import { JSON_CONTENT_TYPE } from "../constants"

export function json(value: unknown): S4ReadResult {
  return {
    kind: "json",
    contentType: JSON_CONTENT_TYPE,
    value,
  }
}

export function directory(path: string, description?: string): S4DirEntry {
  return {
    path,
    name: basename(path),
    kind: "directory",
    capabilities: ["list"],
    ...(description ? { description } : {}),
  }
}

export function jsonFile(path: string, description?: string): S4DirEntry {
  return {
    path,
    name: basename(path),
    kind: "file",
    capabilities: ["read"],
    contentType: JSON_CONTENT_TYPE,
    ...(description ? { description } : {}),
  }
}

export function actionEntry(path: string, description?: string): S4DirEntry {
  return {
    path,
    name: basename(path),
    kind: "action",
    capabilities: ["read", "invoke", "list"],
    ...(description ? { description } : {}),
  }
}

export function segment(value: string): string {
  return encodeURIComponent(value)
}

export function decodeSegment(value: string): string {
  return decodeURIComponent(value)
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? ""
}
