import {
  isSixbApiError,
  type PublishArtifactVersionResponse,
  publishArtifactVersion,
  type SixbClient,
  uploadFile,
} from "@sixb/client"
import type { ArtifactVersion } from "./queries"

/** The version an artifact had moved on to when a save found it, and who published it. */
export interface ArtifactMoved {
  readonly version: number
  readonly author: { readonly type: string; readonly id: string }
}

/** A save refused because another version was published after the one edited. */
export class ArtifactMovedError extends Error {
  readonly name = "ArtifactMovedError"

  constructor(readonly latest: ArtifactMoved) {
    super(`[SixbApp] Version ${latest.version} was published while this one was being edited.`)
  }
}

/**
 * Publishes a person's edit of a version as the artifact's next: uploads only the files that
 * changed, carries every other file over by reference, and publishes from the version edited, so a
 * version published meanwhile is never replaced unseen. A changed path maps to its new contents,
 * or to `null` to leave the file out. Rejects with {@link ArtifactMovedError} when the artifact has
 * moved past the version edited; `baseVersion` names a later one to publish over anyway.
 */
export async function publishEdit(
  version: ArtifactVersion,
  changed: ReadonlyMap<string, Blob | null>,
  options: {
    readonly baseVersion?: number
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
        baseVersion: options.baseVersion ?? version.version,
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

function movedTo(error: unknown): ArtifactMoved | null {
  if (!isSixbApiError(error) || error.status !== 409) return null
  const body = error.body as { code?: unknown; latest?: Partial<ArtifactMoved> } | null
  const latest = body?.latest
  return body?.code === "artifact_moved" &&
    typeof latest?.version === "number" &&
    typeof latest.author?.type === "string" &&
    typeof latest.author.id === "string"
    ? { version: latest.version, author: { type: latest.author.type, id: latest.author.id } }
    : null
}
