import type { AgentContextEntryInput } from "@sixb/core/agents/context"
import { createContext, useContext, useRef } from "react"
import type { ViewerTarget } from "../artifacts/target"
import type { AgentFileRef } from "./types"

const MAX_STORED_THREADS = 50

export interface ThreadComposerDraft {
  readonly text: string
  readonly attachments: readonly AgentFileRef[]
  readonly explicitContext: readonly AgentContextEntryInput[]
}

interface ThreadStateEntry {
  draft?: ThreadComposerDraft
  panelTarget?: ViewerTarget
}

export class ThreadStateStore {
  private readonly entries = new Map<string, ThreadStateEntry>()

  readDraft(draftKey: string): ThreadComposerDraft | null {
    if (!draftKey) return null
    const draft = this.entries.get(draftKey)?.draft
    return draft && !isEmptyDraft(draft) ? draft : null
  }

  writeDraft(draftKey: string, draft: ThreadComposerDraft): void {
    if (!draftKey) return
    const existing = this.entries.get(draftKey)
    if (isEmptyDraft(draft)) {
      if (!existing) return
      if (existing.panelTarget) {
        this.touch(draftKey, { panelTarget: existing.panelTarget })
      } else {
        this.entries.delete(draftKey)
      }
      return
    }
    this.touch(draftKey, {
      ...(existing?.panelTarget ? { panelTarget: existing.panelTarget } : {}),
      draft,
    })
  }

  clearDraft(draftKey: string): void {
    this.writeDraft(draftKey, { text: "", attachments: [], explicitContext: [] })
  }

  readPanelTarget(scopeKey: string): ViewerTarget | null {
    if (!scopeKey || scopeKey === "draft") return null
    return this.entries.get(scopeKey)?.panelTarget ?? null
  }

  writePanelTarget(scopeKey: string, target: ViewerTarget | null): void {
    if (!scopeKey || scopeKey === "draft") return
    const existing = this.entries.get(scopeKey)
    if (target === null) {
      if (!existing) return
      if (existing.draft) {
        this.touch(scopeKey, { draft: existing.draft })
      } else {
        this.entries.delete(scopeKey)
      }
      return
    }
    this.touch(scopeKey, {
      ...(existing?.draft ? { draft: existing.draft } : {}),
      panelTarget: target,
    })
  }

  private touch(key: string, entry: ThreadStateEntry): void {
    if (this.entries.has(key)) {
      this.entries.delete(key)
    } else if (this.entries.size >= MAX_STORED_THREADS) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(key, entry)
  }
}

const storesByOwner = new WeakMap<object, ThreadStateStore>()

/** Return the `ThreadStateStore` scoped to an app-lifetime owner such as `QueryClient`. */
export function threadStateStoreFor(owner: object): ThreadStateStore {
  let store = storesByOwner.get(owner)
  if (!store) {
    store = new ThreadStateStore()
    storesByOwner.set(owner, store)
  }
  return store
}

export const ThreadStateContext = createContext<ThreadStateStore | null>(null)

/**
 * The surrounding conversation store when inside `AgentChat`, or a mount-local store when a
 * component such as `ArtifactPanelRoot` is rendered standalone.
 */
export function useThreadStateStore(owner?: object | null): ThreadStateStore {
  const inherited = useContext(ThreadStateContext)
  const fallbackRef = useRef<ThreadStateStore | null>(null)
  if (inherited) return inherited
  if (owner) return threadStateStoreFor(owner)
  fallbackRef.current ??= new ThreadStateStore()
  return fallbackRef.current
}

function isEmptyDraft(draft: ThreadComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.attachments.length === 0 &&
    draft.explicitContext.length === 0
  )
}
