import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { liveCanvasOf } from "./canvas"
import { liveDocumentOf } from "./document"
import type { LiveNoticeReason } from "./header"
import { useLiveArtifact, useLiveArtifactState } from "./hooks"
import type { LiveArtifact, LiveArtifactState } from "./session"

/** A viewer's hold on an artifact edited live, and whether the reader is editing it. */
export interface LiveView {
  readonly live: LiveArtifact
  readonly state: LiveArtifactState
  /** The reader may edit it now: they edit, and its document holds it. */
  readonly editable: boolean
  readonly editing: boolean
  readonly start: () => void
  readonly stop: () => void
  /** This reader's own changes to take back, and to make again. */
  readonly history: { readonly undo: boolean; readonly redo: boolean }
  readonly undo: () => void
  readonly redo: () => void
  /** Why the reader's hold changed, while it is worth saying; null otherwise. */
  readonly notice: LiveNoticeReason | null
}

/** How long a notice about the reader's hold stays under the header. */
const NOTICE_MS = 6_000

const NO_HISTORY = { undo: false, redo: false }
const noSubscription = () => () => {}

/**
 * Holds the artifact live while its latest version is shown: null for an older version, and for
 * an artifact that is not edited live. A canvas is drawn from the document once it holds it;
 * until then, and if the server never holds it live, the version does, and editing it is a draft.
 * A designed document is typed into through its frame, and its undo is the document's.
 */
export function useLiveView(
  artifactId: string | null,
  kind: "canvas" | "document" = "canvas"
): LiveView | null {
  const live = useLiveArtifact(artifactId)
  const state = useLiveArtifactState(live)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<LiveNoticeReason | null>(null)
  const editable = !!live && state.synced && !state.left && state.access === "edit"

  // Losing the right to change it ends editing, and says why.
  const access = useRef(state.access)
  useEffect(() => {
    const was = access.current
    access.current = state.access
    if (was === "edit" && state.access === "watch") setNotice("access")
  }, [state.access])
  useEffect(() => {
    if (state.left === "not_shared" || state.left === "not_found") setNotice(state.left)
  }, [state.left])
  useEffect(() => {
    if (!editable) setEditing(false)
  }, [editable])
  useEffect(() => {
    if (notice !== "access") return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  const editor =
    live && state.synced ? (kind === "canvas" ? liveCanvasOf(live) : liveDocumentOf(live)) : null
  const history = useSyncExternalStore(
    editor?.subscribe ?? noSubscription,
    editor?.getHistory ?? (() => NO_HISTORY),
    () => NO_HISTORY
  )

  if (!live) return null
  return {
    live,
    state,
    editable,
    editing: editing && editable,
    start: () => setEditing(true),
    stop: () => setEditing(false),
    history: editing ? history : NO_HISTORY,
    undo: () => editor?.undo(),
    redo: () => editor?.redo(),
    notice,
  }
}
