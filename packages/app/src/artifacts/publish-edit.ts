import {
  isSixbApiError,
  type PublishArtifactVersionResponse,
  publishArtifactVersion,
  type SixbClient,
  uploadFile,
} from "@sixb/client"
import type { ArtifactVersion } from "./queries"

type Principal = { readonly type: string; readonly id: string }

/**
 * What an artifact had moved on to when a save found it: its latest version and revision, who last
 * wrote it, and, once someone created that version, who did.
 */
export interface ArtifactMoved {
  readonly version: number
  readonly revision: number
  readonly author: Principal
  readonly frozenBy?: Principal
}

/** A save refused because the artifact changed after the revision edited. */
export class ArtifactMovedError extends Error {
  readonly name = "ArtifactMovedError"

  constructor(readonly latest: ArtifactMoved) {
    super(
      `[SixbApp] The artifact changed to revision ${latest.revision} while it was being edited.`
    )
  }
}

/**
 * Saves a person's edit of a version as the artifact's latest: in place while it is open, as the
 * next version once someone created it. Uploads only the files that changed, carries every other
 * file over by reference, and saves from the revision edited, so a change made meanwhile is never
 * replaced unseen. A changed path maps to its new contents, or to `null` to leave the file out.
 * Rejects with {@link ArtifactMovedError} when the artifact changed since; `baseRevision` names a
 * later revision to save over anyway.
 */
export async function publishEdit(
  version: ArtifactVersion,
  changed: ReadonlyMap<string, Blob | null>,
  options: {
    readonly baseRevision?: number
    readonly client?: SixbClient
    readonly signal?: AbortSignal
  } = {}
): Promise<PublishArtifactVersionResponse> {
  const transport = {
    ...(options.client ? { client: options.client } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
  const upload = async (path: string, contents: Blob) => ({
    path,
    file: await uploadFile(contents, { fileName: path.split("/").at(-1) ?? path, ...transport }),
  })
  // The version's files in their order, changed ones replaced; then files the edit added.
  const files = await Promise.all([
    ...version.files.flatMap((file) => {
      if (!changed.has(file.path)) return [Promise.resolve({ path: file.path, file: file.file })]
      const contents = changed.get(file.path)
      return contents ? [upload(file.path, contents)] : []
    }),
    ...[...changed].flatMap(([path, contents]) =>
      contents && !version.files.some((file) => file.path === path) ? [upload(path, contents)] : []
    ),
  ])
  try {
    const { data } = await publishArtifactVersion({
      path: { artifactId: version.artifactId },
      body: {
        kind: version.outline.kind,
        title: version.title,
        files,
        baseRevision: options.baseRevision ?? version.revision,
      },
      throwOnError: true,
      ...transport,
    })
    return data
  } catch (error) {
    const latest = movedTo(error)
    if (latest) throw new ArtifactMovedError(latest)
    throw error
  }
}

/** The latest version a 409 `artifact_moved` names, read from the API's body. */
export function movedTo(error: unknown): ArtifactMoved | null {
  if (!isSixbApiError(error) || error.status !== 409) return null

  const body = error.body as { code?: unknown; latest?: Partial<ArtifactMoved> } | null
  const latest = body?.latest
  if (
    body?.code !== "artifact_moved" ||
    typeof latest?.version !== "number" ||
    typeof latest.revision !== "number" ||
    !isPrincipal(latest.author)
  ) {
    return null
  }

  return {
    version: latest.version,
    revision: latest.revision,
    author: { type: latest.author.type, id: latest.author.id },
    ...(isPrincipal(latest.frozenBy)
      ? { frozenBy: { type: latest.frozenBy.type, id: latest.frozenBy.id } }
      : {}),
  }
}

function isPrincipal(value: unknown): value is Principal {
  const principal = value as Partial<Principal> | null | undefined
  return typeof principal?.type === "string" && typeof principal.id === "string"
}
