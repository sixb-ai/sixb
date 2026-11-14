import type { UpdateArtifactResponse } from "@sixb/client"
import { getArtifactVersionQueryKey } from "@sixb/client/hooks"
import type { QueryClient } from "@tanstack/react-query"
import { createContext, type ReactNode, useContext, useEffect } from "react"
import { artifactFileSource } from "./file-source"
import { publishEdit } from "./publish-edit"
import { type ArtifactVersion, fileTextQueryKey } from "./queries"

/** What a renderer editing a version tells the viewer: whether it changed anything, and what. */
export interface ArtifactDraft {
  readonly changed: boolean
  /** The files a save publishes: each changed path with its new text, or `null` to drop it. */
  readonly files: () => ReadonlyMap<string, string | null>
  /** Takes back the last change; absent when there is none. */
  readonly undo?: () => void
  /** Makes again the last change taken back; absent when there is none. */
  readonly redo?: () => void
}

interface EditSession {
  /** Whether the reader is editing the version shown. */
  readonly editing: boolean
  readonly report: (draft: ArtifactDraft | null) => void
  /**
   * Starts editing, as the header's Edit does: absent while the reader edits already, or may not
   * change the artifact.
   */
  readonly start?: (() => void) | undefined
}

const EditSessionContext = createContext<EditSession>({ editing: false, report: () => {} })

export function EditSessionProvider({
  editing,
  report,
  start,
  children,
}: EditSession & { readonly children: ReactNode }) {
  return (
    <EditSessionContext.Provider value={{ editing, report, start }}>
      {children}
    </EditSessionContext.Provider>
  )
}

/** Whether the version shown is being edited: a renderer that edits shows its editing tools. */
export function useArtifactEditing(): boolean {
  return useContext(EditSessionContext).editing
}

/**
 * Starts editing from within the artifact, as the header's Edit does, for a change the reader
 * makes there; null while they edit already, or may not change it.
 */
export function useStartEditing(): (() => void) | null {
  return useContext(EditSessionContext).start ?? null
}

/** Tells the viewer what the renderer's draft holds, for the header's Save. */
export function useReportDraft(draft: ArtifactDraft | null): void {
  const { report } = useContext(EditSessionContext)
  useEffect(() => {
    report(draft)
  }, [report, draft])
  useEffect(() => () => report(null), [report])
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  json: "application/json",
}

/**
 * Saves a draft as the artifact's latest, and fills the cache with what it saved: the version, and
 * each file's text, the changed ones from the draft and the rest from the version edited, so it
 * shows at once, without reading again what the reader already has.
 */
export async function saveDraft(
  queries: QueryClient,
  version: ArtifactVersion,
  draft: ArtifactDraft,
  options: { readonly baseRevision?: number } = {}
): Promise<UpdateArtifactResponse> {
  const texts = draft.files()
  const changed = new Map(
    [...texts].map(([path, text]) => [
      path,
      text === null
        ? null
        : new Blob([text], { type: MEDIA_TYPES[path.split(".").at(-1) ?? ""] ?? "text/plain" }),
    ])
  )
  const published = await publishEdit(version, changed, options)
  const next = published.version as ArtifactVersion
  queries.setQueryData(
    getArtifactVersionQueryKey({
      path: { artifactId: next.artifactId, version: String(next.version) },
    }),
    next
  )
  for (const file of next.files) {
    const before = version.files.find((candidate) => candidate.path === file.path)
    const text =
      texts.get(file.path) ??
      (before && before.file.digest === file.file.digest
        ? queries.getQueryData<string>(
            fileTextQueryKey(
              artifactFileSource({
                ...versionPlace(version),
                path: file.path,
                fileRef: before.file,
              })
            )
          )
        : undefined)
    if (typeof text !== "string") continue
    queries.setQueryData(
      fileTextQueryKey(
        artifactFileSource({ ...versionPlace(next), path: file.path, fileRef: file.file })
      ),
      text
    )
  }
  return published
}

function versionPlace(version: ArtifactVersion) {
  return { artifactId: version.artifactId, version: version.version }
}
