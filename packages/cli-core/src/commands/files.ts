import { basename } from "node:path"
import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp, requireExact } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { type UploadProgress, uploadFile } from "../upload"
import { GROUP_HELP } from "./metadata"
import { idSegment } from "./shared"

export async function files(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.files)
  if (sub === "upload") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--logical-path": "string", "--media-type": "string" },
      "files upload",
      1
    )
    const source = positionals[0] ?? ""
    const logicalPath = options["--logical-path"]
    const mediaType = options["--media-type"]
    const progress = process.stderr.isTTY ? progressLine(basename(source)) : undefined
    try {
      const fileRef = await uploadFile(api, source, {
        ...(logicalPath ? { logicalPath } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(progress ? { onProgress: progress.show } : {}),
      })
      progress?.clear()
      return writeJson(fileRef)
    } catch (error) {
      progress?.clear()
      throw error
    }
  }
  if (sub === "download") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--path": "string", "--output": "string" },
      "files download",
      [2, 3]
    )
    const context = positionals[0]
    const output = options["--output"]
    if (context === "url") {
      // A content URL a manifest lists, such as an attachment's: fetched the way every other
      // command reaches the API, so its credential is added wherever the CLI's address adds it.
      requireExact(positionals, 2, "files download url requires exactly one content URL.")
      const url = parseContentUrl(positionals[1] ?? "")
      if (!output) fail("files download requires --output <local-path>.")
      await api.download(url.pathname, output, Object.fromEntries(url.searchParams))
      return writeJson({ downloaded: true, output })
    }
    let route: string
    if (context === "object") {
      requireExact(positionals, 3, "files download object requires object type and primary id.")
      const type = positionals[1] ?? ""
      const id = positionals[2] ?? ""
      route = `/api/objects/${idSegment(type)}/${idSegment(id)}/files/content`
    } else if (context === "action-run" || context === "workflow-run") {
      requireExact(positionals, 2, `files download ${context} requires exactly one run id.`)
      const id = positionals[1] ?? ""
      route = `/api/${context}s/${idSegment(id)}/files/content`
    } else fail(`Unknown file download context '${context}'.`)
    const path = options["--path"]
    if (!path) fail("files download requires --path <json-pointer>.")
    if (!output) fail("files download requires --output <local-path>.")
    await api.download(route, output, { path })
    return writeJson({ downloaded: true, output })
  }
  fail(`Unknown files command '${sub}'.`)
}

/**
 * One line on a terminal's stderr that follows a large upload, and is cleared once it ends: stdout
 * keeps only the FileRef, and nothing is drawn where no one watches.
 */
function progressLine(name: string): {
  readonly show: (progress: UploadProgress) => void
  readonly clear: () => void
} {
  let shown = ""
  return {
    show({ stage, loadedBytes, totalBytes }) {
      const percent = Math.floor((loadedBytes / Math.max(1, totalBytes)) * 100)
      const line =
        stage === "hash"
          ? `Checking ${name}… ${percent}%`
          : `Uploading ${name}… ${percent}% of ${megabytes(totalBytes)}`
      if (line === shown) return
      shown = line
      process.stderr.write(`\r\x1b[2K${line}`)
    },
    clear() {
      if (shown) process.stderr.write("\r\x1b[2K")
    },
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A Sixb API file content URL: only its path and query are used, never its origin. */
function parseContentUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail(`'${value}' is not a URL.`)
  }
  if (!url.pathname.startsWith("/api/") || !url.pathname.endsWith("/files/content")) {
    fail(`'${value}' is not a Sixb file content URL.`)
  }
  return url
}
