import type { AgentContextEntryInput } from "@sixb/core/agents/context"
import type { ArtifactTarget, FileTarget, ViewerTarget } from "../artifacts/target"
import type { AgentFileRef } from "./types"

const THREAD_STATE_KEY = "sixb.agent.thread-state.v1"
const SESSION_EPOCH_KEY = "sixb.agent.thread-state.epoch"
const MAX_STORED_THREADS = 50

export interface ThreadComposerDraft {
  readonly text: string
  readonly attachments: readonly AgentFileRef[]
  readonly explicitContext: readonly AgentContextEntryInput[]
}

interface StoredThreadEntry {
  readonly draft?: ThreadComposerDraft
  readonly artifact?: ArtifactTarget
  readonly updatedAt: number
}

type StoredThreadMap = Record<string, StoredThreadEntry>

// In-memory store for non-serializable `FileTarget`s, tied to the active sessionStorage epoch so
// clearing sessionStorage (logout or test teardown) resets in-memory targets automatically.
let memoryEpoch: string | null = null
const memoryFileTargets = new Map<string, FileTarget>()

function sessionStore(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage ?? null
  } catch {
    return null
  }
}

function syncMemoryEpoch(storage: Storage | null): void {
  if (!storage) {
    memoryFileTargets.clear()
    memoryEpoch = null
    return
  }
  try {
    const current = storage.getItem(SESSION_EPOCH_KEY)
    if (current && current === memoryEpoch) return
    if (!current) {
      memoryFileTargets.clear()
      const next = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      storage.setItem(SESSION_EPOCH_KEY, next)
      memoryEpoch = next
      return
    }
    memoryEpoch = current
  } catch {
    // Restricted storage contexts fall back cleanly.
  }
}

function readAll(storage: Storage | null): StoredThreadMap {
  if (!storage) return {}
  try {
    const raw = storage.getItem(THREAD_STATE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) ? (parsed as StoredThreadMap) : {}
  } catch {
    return {}
  }
}

function writeAll(storage: Storage | null, entries: StoredThreadMap): void {
  if (!storage) return
  try {
    const keys = Object.keys(entries)
    if (keys.length === 0) {
      storage.removeItem(THREAD_STATE_KEY)
      return
    }
    const kept =
      keys.length <= MAX_STORED_THREADS
        ? entries
        : Object.fromEntries(
            Object.entries(entries)
              .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
              .slice(0, MAX_STORED_THREADS)
          )
    storage.setItem(THREAD_STATE_KEY, JSON.stringify(kept))
  } catch {
    // Storage quota or privacy mode: keep running without throwing.
  }
}

function isEmptyDraft(draft: ThreadComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.attachments.length === 0 &&
    draft.explicitContext.length === 0
  )
}

/** Read the unsent composer draft saved for `draftKey` (a thread id or `"draft"`). */
export function readThreadDraft(draftKey: string): ThreadComposerDraft | null {
  if (!draftKey) return null
  const storage = sessionStore()
  syncMemoryEpoch(storage)
  const entry = readAll(storage)[draftKey]
  if (!entry || !isRecord(entry.draft)) return null
  const { text, attachments, explicitContext } = entry.draft as Record<string, unknown>
  if (typeof text !== "string") return null
  const validAttachments = Array.isArray(attachments) ? attachments.filter(isFileRef) : []
  const validContext = Array.isArray(explicitContext)
    ? explicitContext.filter(isExplicitContextEntry)
    : []
  const draft: ThreadComposerDraft = {
    text,
    attachments: validAttachments,
    explicitContext: validContext,
  }
  return isEmptyDraft(draft) ? null : draft
}

/** Save or clear the unsent composer draft for `draftKey`. */
export function writeThreadDraft(draftKey: string, draft: ThreadComposerDraft): void {
  if (!draftKey) return
  const storage = sessionStore()
  syncMemoryEpoch(storage)
  const entries = { ...readAll(storage) }
  const current = entries[draftKey]

  if (isEmptyDraft(draft)) {
    if (!current) return
    if (current.artifact) {
      entries[draftKey] = { artifact: current.artifact, updatedAt: Date.now() }
    } else {
      delete entries[draftKey]
    }
    writeAll(storage, entries)
    return
  }

  entries[draftKey] = {
    ...(current?.artifact ? { artifact: current.artifact } : {}),
    draft,
    updatedAt: Date.now(),
  }
  writeAll(storage, entries)
}

export function clearThreadDraft(draftKey: string): void {
  writeThreadDraft(draftKey, { text: "", attachments: [], explicitContext: [] })
}

/** Read the open artifact or file viewer target remembered for a durable thread `scopeKey`. */
export function readThreadPanelTarget(scopeKey: string): ViewerTarget | null {
  if (!scopeKey || scopeKey === "draft") return null
  const storage = sessionStore()
  syncMemoryEpoch(storage)
  const memoryFile = memoryFileTargets.get(scopeKey)
  if (memoryFile) return memoryFile
  const entry = readAll(storage)[scopeKey]
  return entry && isArtifactTarget(entry.artifact) ? entry.artifact : null
}

/** Remember or clear the open artifact or file viewer target for a durable thread `scopeKey`. */
export function writeThreadPanelTarget(scopeKey: string, target: ViewerTarget | null): void {
  if (!scopeKey || scopeKey === "draft") return
  const storage = sessionStore()
  syncMemoryEpoch(storage)
  const entries = { ...readAll(storage) }
  const current = entries[scopeKey]

  if (target === null) {
    memoryFileTargets.delete(scopeKey)
    if (!current) return
    if (current.draft) {
      entries[scopeKey] = { draft: current.draft, updatedAt: Date.now() }
    } else {
      delete entries[scopeKey]
    }
    writeAll(storage, entries)
    return
  }

  if (target.type === "file") {
    memoryFileTargets.set(scopeKey, target)
    if (current?.artifact) {
      if (current.draft) {
        entries[scopeKey] = { draft: current.draft, updatedAt: Date.now() }
      } else {
        delete entries[scopeKey]
      }
      writeAll(storage, entries)
    }
    return
  }

  memoryFileTargets.delete(scopeKey)
  entries[scopeKey] = {
    ...(current?.draft ? { draft: current.draft } : {}),
    artifact: target,
    updatedAt: Date.now(),
  }
  writeAll(storage, entries)
}

function isArtifactTarget(value: unknown): value is ArtifactTarget {
  if (!isRecord(value) || value.type !== "artifact") return false
  if (typeof value.artifactId !== "string" || value.artifactId.trim().length === 0) return false
  if (
    value.version !== undefined &&
    (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1)
  ) {
    return false
  }
  if (value.part !== undefined && typeof value.part !== "string") return false
  return true
}

function isFileRef(value: unknown): value is AgentFileRef {
  return (
    isRecord(value) &&
    typeof value.blobId === "string" &&
    typeof value.digest === "string" &&
    typeof value.sizeBytes === "number"
  )
}

function isExplicitContextEntry(value: unknown): value is AgentContextEntryInput {
  return isRecord(value) && value.origin === "explicit" && isRecord(value.context)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
