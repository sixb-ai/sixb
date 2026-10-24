import {
  client,
  getAgentChildFileContent,
  getAgentMessageFileContent,
  getAiModelCallFileContent,
  getArtifactFileContent,
  getObservedAgentChildFileContent,
  getObservedAgentMessageFileContent,
} from "@sixb/client"
import { useArtifactMessages } from "./messages"

/** The parts of a stored file reference the viewer reads. */
export interface ViewerFileRef {
  readonly blobId: string
  readonly digest: string
  readonly sizeBytes: number
  readonly fileName?: string
  readonly mediaType?: string
}

/**
 * A file the viewer can show, tied to the route that authorizes reading it: a file of an artifact
 * version, a file in a conversation message, or a file a model call produced.
 */
export interface FileSource {
  readonly id: string
  readonly fileRef: ViewerFileRef
  /**
   * The file's name: its path in an artifact, else its own name. Empty for a message file that
   * has none, which a view names in the reader's language with {@link useFileName}.
   */
  readonly name: string
  readonly inlineUrl: string
  readonly downloadUrl: string
  /** Identity of its bytes in the query cache. */
  readonly queryKey: readonly unknown[]
  readonly load: (signal: AbortSignal) => Promise<Blob>
}

export function artifactFileSource(input: {
  readonly artifactId: string
  readonly version: number
  readonly path: string
  readonly fileRef: ViewerFileRef
  /** Explicit base URL for pure callers and tests. Defaults to the configured Sixb client URL. */
  readonly baseUrl?: string
}): FileSource {
  const routePath = `/api/artifacts/${encodeURIComponent(input.artifactId)}/versions/${input.version}/content`
  const url = (disposition: "inline" | "attachment") =>
    contentUrl(routePath, { path: input.path, disposition }, input.baseUrl)
  return {
    id: `artifact:${input.artifactId}@${input.version}/${input.path}`,
    fileRef: input.fileRef,
    name: input.path,
    inlineUrl: url("inline"),
    downloadUrl: url("attachment"),
    queryKey: ["artifact-file", input.artifactId, input.version, input.path, input.fileRef.digest],
    load: async (signal) => {
      const response = await getArtifactFileContent({
        path: { artifactId: input.artifactId, version: String(input.version) },
        query: { path: input.path, disposition: "inline" },
        parseAs: "blob",
        throwOnError: true,
        signal,
      })
      return response.data
    },
  }
}

export function messageFileSource(input: {
  readonly threadId: string
  readonly messageId: string
  /** JSON pointer to the file reference in the message, such as `/parts/2/fileRef`. */
  readonly path: string
  readonly fileRef: ViewerFileRef
  /** Read through the observer's routes: the conversation is someone else's. */
  readonly observed?: boolean
  readonly baseUrl?: string
}): FileSource {
  const threads = input.observed ? "observed-agent-threads" : "agent-threads"
  const routePath = `/api/${threads}/${encodeURIComponent(input.threadId)}/messages/${encodeURIComponent(
    input.messageId
  )}/files/content`
  const read = input.observed ? getObservedAgentMessageFileContent : getAgentMessageFileContent
  const url = (disposition: "inline" | "attachment") =>
    contentUrl(routePath, { path: input.path, disposition }, input.baseUrl)
  return {
    id: `message:${input.messageId}${input.path}`,
    fileRef: input.fileRef,
    name: input.fileRef.fileName?.trim() ?? "",
    inlineUrl: url("inline"),
    downloadUrl: url("attachment"),
    queryKey: ["message-file", input.threadId, input.messageId, input.path, input.fileRef.digest],
    load: async (signal) => {
      const response = await read({
        path: { threadId: input.threadId, messageId: input.messageId },
        query: { path: input.path, disposition: "inline" },
        parseAs: "blob",
        throwOnError: true,
        signal,
      })
      return response.data
    },
  }
}

/**
 * A file of one run of a sub-agent: one it was handed (`/handedFiles/0/fileRef`) or one the run
 * returned (`/files/1/fileRef`). What a tool showed it is a file of its thread's messages.
 */
export function childFileSource(input: {
  /** The sub-agent's thread. */
  readonly threadId: string
  /** The run of it the file is of. */
  readonly runId: string
  readonly path: string
  readonly fileRef: ViewerFileRef
  /** Read through the observer's routes: the conversation is someone else's. */
  readonly observed?: boolean
  readonly baseUrl?: string
}): FileSource {
  const thread = encodeURIComponent(input.threadId)
  const routePath = input.observed
    ? `/api/observed-agent-threads/${thread}/child-files/content`
    : `/api/agent-threads/${thread}/child-files/content`
  const url = (disposition: "inline" | "attachment") =>
    contentUrl(routePath, { run: input.runId, path: input.path, disposition }, input.baseUrl)
  return {
    id: `child:${input.runId}${input.path}`,
    fileRef: input.fileRef,
    name: input.fileRef.fileName?.trim() ?? "",
    inlineUrl: url("inline"),
    downloadUrl: url("attachment"),
    queryKey: ["child-file", input.threadId, input.runId, input.path, input.fileRef.digest],
    load: async (signal) => {
      const query = { run: input.runId, path: input.path, disposition: "inline" as const }
      const options = {
        path: { threadId: input.threadId },
        query,
        parseAs: "blob" as const,
        throwOnError: true as const,
        signal,
      }
      const response = input.observed
        ? await getObservedAgentChildFileContent(options)
        : await getAgentChildFileContent(options)
      return response.data as Blob
    },
  }
}

/** A file a model call produced, such as an image the agent made, by its place in the call. */
export function modelCallFileSource(input: {
  readonly callId: string
  readonly index: number
  readonly fileRef: ViewerFileRef
  /** The name the file was saved under, for a file the call stored without one. */
  readonly fileName?: string
  readonly baseUrl?: string
}): FileSource {
  const routePath = `/api/ai/model-calls/${encodeURIComponent(input.callId)}/files/content`
  const path = `/files/${input.index}`
  const url = (disposition: "inline" | "attachment") =>
    contentUrl(routePath, { path, disposition }, input.baseUrl)
  return {
    id: `model-call:${input.callId}${path}`,
    fileRef: input.fileRef,
    name: input.fileRef.fileName?.trim() || input.fileName?.trim() || "",
    inlineUrl: url("inline"),
    downloadUrl: url("attachment"),
    queryKey: ["model-call-file", input.callId, input.index, input.fileRef.digest],
    load: async (signal) => {
      const response = await getAiModelCallFileContent({
        path: { callId: input.callId },
        query: { path, disposition: "inline" },
        parseAs: "blob",
        throwOnError: true,
        signal,
      })
      return response.data
    },
  }
}

/** The file's name to show: its own, or a word for a file in the reader's language. */
export function useFileName(source: FileSource): string {
  const messages = useArtifactMessages().files
  return source.name || messages.file
}

function contentUrl(routePath: string, query: Record<string, string>, baseUrl?: string): string {
  const params = new URLSearchParams(query)
  const base = baseUrl ?? client.getConfig().baseUrl
  if (!base && typeof window === "undefined") return `${routePath}?${params}`
  const url = new URL(routePath, base ?? window.location.origin)
  url.search = params.toString()
  return url.toString()
}
