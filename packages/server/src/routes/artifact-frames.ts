import type { SixbHostView } from "@sixb/core"
import { parseArtifactAddress } from "@sixb/core/artifacts"
import { annotateBoard } from "@sixb/core/artifacts/live"
import type { FileRef } from "@sixb/core/blob-storage"
import {
  ARTIFACT_FRAME_ROUTE_PREFIX,
  FRAME_ASSETS,
  FRAME_REFERENCE_PATH,
  FRAME_REFERENCE_PREFIX,
  frameEntries,
  frameLayout,
  frozenDocumentHtml,
  injectFrameAssets,
  MEDIA_PROXY_PARAM,
  markDocumentSections,
  requestedMediaProxy,
  resolveArtifactFrame,
  rewriteFrameReferences,
  rewriteVideoProxies,
} from "@sixb/core/internal/artifacts/frames"
import { openFileRef } from "@sixb/core/internal/blob-storage"
import type {
  ArtifactFile,
  ArtifactFrameTarget,
  ArtifactMediaRecord,
  ArtifactStorage,
  ArtifactVersionRecord,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { frameContentSecurityPolicy } from "../artifacts/frame"
import type { ResolvedSixbApiBrowserPolicy } from "../auth/browser-origin"
import { createFileContentResponse } from "../files/content"

interface FrameContext {
  readonly params: { readonly token: string; readonly "*": string }
  readonly request: Request
}

/**
 * Serves a version's files to its sandboxed frame, under the token a frame link carries: the token
 * is the credential, so the route is public. Each entry gets its layout's kit and the runtime,
 * which are served beside the files. A canvas's board, or a designed document, asked for with
 * `?sixb-edit` is served for editing: its static elements marked with their addresses. Hidden from
 * OpenAPI: clients receive frame links, they never build them.
 */
export function registerArtifactFrameRoutes(
  app: Elysia,
  host: SixbHostView,
  policy: ResolvedSixbApiBrowserPolicy
) {
  const path = `${ARTIFACT_FRAME_ROUTE_PREFIX}:token/*`
  return app
    .get(path, (context) => frameResponse(host, policy, context), { detail: { hide: true } })
    .head(path, (context) => frameResponse(host, policy, context, { head: true }), {
      detail: { hide: true },
    })
}

async function frameResponse(
  host: SixbHostView,
  policy: ResolvedSixbApiBrowserPolicy,
  { params, request }: FrameContext,
  options: { readonly head?: boolean } = {}
): Promise<Response> {
  const headers = new Headers({
    "content-security-policy": frameContentSecurityPolicy({ policy, request, token: params.token }),
    // The frame's origin is opaque, so its module scripts and fonts arrive with `Origin: null`.
    // Nothing here depends on cookies: the token is the credential.
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  })
  const notFound = () => {
    headers.set("content-type", "text/plain; charset=utf-8")
    headers.set("cache-control", "no-store")
    return new Response(options.head ? null : "Not found", { status: 404, headers })
  }

  // A frame link opens only in a frame. Opened as a page on the API's origin, its sandbox would
  // still let it show dialogs under the API's address, with no app policy to hold where it goes.
  if (request.headers.get("sec-fetch-dest") === "document") return notFound()

  const storage = host.storage.artifacts
  if (!storage) return notFound()
  // An unknown or expired token, a deleted version, and a kind with no frame all answer one 404.
  const frame = await resolveArtifactFrame({
    projectId: host.id,
    storage,
    token: params.token,
  })
  if (!frame) return notFound()
  let version = frame.version

  let path = decodePath(params["*"])
  const asset = path === null ? undefined : FRAME_ASSETS[path]
  if (asset) {
    headers.set("content-type", asset.type)
    headers.set("cache-control", "private, max-age=3600")
    return new Response(options.head ? null : asset.body, { headers })
  }
  let lent = false
  if (path?.startsWith(FRAME_REFERENCE_PREFIX)) {
    // A file another artifact lends this one: only one its frame was issued with. A pinned
    // address shows its created version; an unpinned one the lender's latest, as it is now.
    const match = FRAME_REFERENCE_PATH.exec(path.slice(FRAME_REFERENCE_PREFIX.length))
    const target = frame.targets.find(
      (candidate) =>
        candidate.artifactId === match?.[1] &&
        String(candidate.version) === match?.[2] &&
        parseArtifactAddress(candidate.address)?.path === match?.[3]
    )
    const lender = target ? await lenderVersion(storage, host.id, target) : null
    if (!lender || !match) return notFound()
    version = lender
    path = match[3] ?? null
    lent = true
  }
  const file = version.files.find((candidate) => candidate.path === path)
  if (!file) return notFound()

  const search = new URL(request.url).searchParams
  // A video's frame plays each recording's proxy once it is ready, its own and those other
  // artifacts lend it, named in its HTML, its scenes' included, by an address of the proxy's own:
  // a page that loaded the original keeps it.
  const video = frame.version.outline.kind === "video"
  const recordings =
    video && !lent && isHtml(file.path) ? await videoRecordings(storage, host.id, frame) : undefined

  const layout = frameLayout(version)
  const entry = !lent && layout !== null && frameEntries(version).includes(file.path)
  if (recordings && !entry) {
    const text = await readText(host, file.file)
    if (text === null) return notFound()
    headers.set("content-type", "text/html; charset=utf-8")
    headers.set("cache-control", "private, no-cache")
    if (options.head) return new Response(null, { headers })

    const referenced = rewriteFrameReferences(text, frame.targets, file.path)
    return new Response(
      rewriteVideoProxies(referenced, file.path, recordings.files, recordings.media),
      { headers }
    )
  }

  if (entry && layout) {
    const text = await readText(host, file.file)
    if (text === null) return notFound()
    headers.set("content-type", "text/html; charset=utf-8")
    headers.set("cache-control", "private, no-cache")
    if (options.head) return new Response(null, { headers })

    const { outline } = version
    // A canvas's board, or a designed document, served for editing has its static elements
    // marked with their addresses, for the runtime to report and edit them by.
    const editing =
      (outline.kind === "canvas" || outline.kind === "document") && search.has("sixb-edit")
    const marked = editing ? annotateBoard(text) : text
    // A frozen designed document shows the values written in when it was frozen: its fields are
    // served unmarked, so its frame reads none again.
    const shown =
      outline.kind === "document" && version.frozenAt ? frozenDocumentHtml(marked) : marked
    // A designed document's headings carry their sections' slugs, to open it at one, and its
    // runtime gets its paper, to cut it into pages.
    const source =
      outline.kind === "document" ? markDocumentSections(shown, outline.headings) : shown
    const referenced = rewriteFrameReferences(source, frame.targets, file.path)
    return new Response(
      injectFrameAssets(
        recordings
          ? rewriteVideoProxies(referenced, file.path, recordings.files, recordings.media)
          : referenced,
        layout,
        file.path,
        outline.kind === "document" ? outline.paper : undefined
      ),
      { headers }
    )
  }

  // A proxy that is not the recording's ready one is never served as if it were. A lent one is
  // served only where its original is: under a target the frame was issued for its reader.
  const proxy =
    video && search.has(MEDIA_PROXY_PARAM)
      ? requestedMediaProxy(file, await keptMedia(storage, host.id, file), search)
      : undefined
  if (proxy === null) return notFound()

  const response = await createFileContentResponse({
    blobStorage: host.blobStorage,
    fileRef: proxy ?? file.file,
    disposition: "inline",
    head: options.head,
    request,
  })
  if (!response) return notFound()
  // A frame loads its files as the page's parts: inline, under the frame's own policy.
  for (const [name, value] of headers) response.headers.set(name, value)
  response.headers.set("content-disposition", "inline")
  return response
}

/**
 * The recordings a video's frame plays, at the paths it serves them: the version's own, and each
 * one a target lends it under `__sixb/ref/`, with what is derived of each, by the digest of its
 * bytes. Only a file a target names is lent, so only one its reader may read.
 */
async function videoRecordings(
  storage: ArtifactStorage,
  projectId: string,
  frame: {
    readonly version: ArtifactVersionRecord
    readonly targets: readonly ArtifactFrameTarget[]
  }
): Promise<{
  readonly files: readonly ArtifactFile[]
  readonly media: ReadonlyMap<string, ArtifactMediaRecord>
}> {
  const files = [...frame.version.files]
  for (const target of frame.targets) {
    const path = parseArtifactAddress(target.address)?.path
    const lender = path ? await lenderVersion(storage, projectId, target) : null
    const lent = lender?.files.find((candidate) => candidate.path === path)
    if (!lent || !isRecording(lent)) continue

    files.push({
      path: `${FRAME_REFERENCE_PREFIX}${target.artifactId}@${target.version}/${path}`,
      file: lent.file,
    })
  }
  const digests = new Set(files.filter(isRecording).map(({ file }) => file.digest))
  if (digests.size === 0) return { files, media: new Map() }

  const records = await storage.listMedia({ projectId, digests: [...digests] })
  return { files, media: new Map(records.map((record) => [record.digest, record])) }
}

/** What is derived of a recording, by the digest of its bytes. */
async function keptMedia(
  storage: ArtifactStorage,
  projectId: string,
  file: ArtifactFile
): Promise<ArtifactMediaRecord | undefined> {
  const [record] = await storage.listMedia({ projectId, digests: [file.file.digest] })
  return record
}

function isRecording({ file }: ArtifactFile): boolean {
  return /^(video|audio)\//.test(file.mediaType ?? "")
}

async function readText(host: SixbHostView, file: FileRef): Promise<string | null> {
  const opened = await openFileRef(host.blobStorage, file)
  return opened ? await new Response(opened.body).text() : null
}

function isHtml(path: string): boolean {
  return /\.html?$/i.test(path)
}

async function lenderVersion(
  storage: ArtifactStorage,
  projectId: string,
  target: ArtifactFrameTarget
): Promise<ArtifactVersionRecord | null> {
  const { artifactId } = target
  const version =
    target.version === "latest"
      ? (await storage.get({ projectId, id: artifactId }))?.latestVersion
      : target.version
  if (version === undefined) return null

  return storage.getVersion({ projectId, artifactId, version })
}

function decodePath(raw: string | undefined): string | null {
  try {
    return decodeURIComponent(raw ?? "")
  } catch {
    return null
  }
}
