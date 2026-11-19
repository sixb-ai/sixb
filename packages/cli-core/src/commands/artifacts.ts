import type { ApiClient } from "../api-client"
import { enumValue, isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { idSegment, readText } from "./shared"

// An artifact's comments, as the people reading it leave them: read them as threads, resolve the
// ones whose change is made, and reply to one to say why it is not. The Agent's run reaches them
// as the person it answers, through the conversation that shares the artifact. A video's MP4,
// rendered when asked, and downloaded once it is. What is derived of a video or a sound it holds:
// read, and each part's file downloaded.

const STATUSES = ["open", "resolved", "all"] as const

/** The longest comment the API takes, in characters. */
const MAX_BODY_LENGTH = 4_000

interface Comment {
  readonly id: string
  readonly parentId?: string
  readonly resolvedAt?: string
  readonly [key: string]: unknown
}

export async function artifacts(api: ApiClient, args: readonly string[]): Promise<void> {
  const [group, sub, ...rest] = args
  if (!group || isHelp(group)) return writeText(GROUP_HELP.artifacts)
  if (group === "export") return exportVideo(api, args.slice(1))
  if (group === "media") return media(api, args.slice(1))
  if (group !== "comments") fail(`Unknown artifacts command '${group}'.`)
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.artifacts)

  if (sub === "list") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--status": "string" },
      "artifacts comments list",
      1
    )
    const artifact = idSegment(positionals[0]?.trim())
    const status = enumValue("--status", options["--status"] ?? "open", STATUSES)
    const page = await api.get(`/api/artifacts/${artifact}/comments`)
    return writeJson({ threads: threadsOf(commentsOf(page), status) })
  }

  if (sub === "resolve") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--reopen": "boolean" },
      "artifacts comments resolve",
      2
    )
    const [artifact, comment] = positionals.map((value) => idSegment(value.trim()))
    return writeJson(
      await api.post(`/api/artifacts/${artifact}/comments/${comment}/resolve`, {
        resolved: options["--reopen"] !== true,
      })
    )
  }

  if (sub === "reply") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--file": "string" },
      "artifacts comments reply",
      [2, 3]
    )
    const [artifactId, commentId, words] = positionals
    const body = (
      options["--file"] ? await readText(options["--file"], "reply") : (words ?? "")
    ).trim()
    if (!body) fail("artifacts comments reply requires the reply's words, or --file <path|->.")
    if (body.length > MAX_BODY_LENGTH) {
      fail(`A reply holds at most ${MAX_BODY_LENGTH} characters.`)
    }

    return writeJson(
      await api.post(`/api/artifacts/${idSegment(artifactId?.trim())}/comments`, {
        body,
        parentId: commentId?.trim(),
      })
    )
  }

  fail(`Unknown artifacts comments command '${sub}'.`)
}

/** How often an export that renders is asked about, and how long it is waited for at most. */
const EXPORT_POLL_MS = 3_000
const EXPORT_WAIT_MS = 60 * 60_000

interface VideoExport {
  readonly status: "ready" | "rendering" | "failed"
  readonly reason?: string
  readonly progress?: {
    readonly ready: number
    readonly total: number
    readonly assembling: boolean
  }
}

/**
 * A video's MP4: asked for, and its status printed; with --output, waited for while it renders,
 * then downloaded there.
 */
async function exportVideo(api: ApiClient, args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) return writeText(GROUP_HELP.artifacts)
  const { positionals, options } = parseCommandArgs(
    args,
    { "--version": "string", "--retry": "boolean", "--output": "string" },
    "artifacts export",
    1
  )
  const version = options["--version"]?.trim() || "latest"
  if (!/^(latest|[1-9]\d*)$/.test(version)) {
    fail('artifacts export --version is a version number, or "latest".')
  }
  const path = `/api/artifacts/${idSegment(positionals[0]?.trim())}/versions/${version}/video`
  const ask = async (retry: boolean) =>
    (await api.post(`${path}${retry ? "?retry=true" : ""}`, {})) as VideoExport

  let asked = await ask(options["--retry"] === true)
  const output = options["--output"]
  if (!output) return writeJson(asked)

  const progress = process.stderr.isTTY ? exportProgress() : undefined
  const deadline = Date.now() + EXPORT_WAIT_MS
  try {
    while (asked.status === "rendering") {
      progress?.show(asked)
      if (Date.now() > deadline) {
        fail("The video is still rendering. Run the command again to keep waiting.", "timeout")
      }
      await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS))
      asked = await ask(false)
    }
  } finally {
    progress?.clear()
  }
  if (asked.status === "failed") {
    fail(
      `The video could not be rendered: ${asked.reason ?? "no reason given"}`,
      "video_failed",
      "Run the command again with --retry to render what failed anew."
    )
  }

  await api.download(path, output)
  return writeJson({ ...asked, downloaded: true, output })
}

function exportProgress() {
  let shown = ""
  return {
    show({ progress }: VideoExport) {
      const line = progress?.assembling
        ? "Joining the scenes…"
        : `Rendering… ${progress?.ready ?? 0} of ${progress?.total ?? 0} segments`
      if (line === shown) return
      shown = line
      process.stderr.write(`\r\x1b[2K${line}`)
    },
    clear() {
      if (shown) process.stderr.write("\r\x1b[2K")
    },
  }
}

/** The parts of a media that are files, each downloaded with --part. */
const MEDIA_FILES = ["proxy", "poster", "filmstrip", "waveform", "transcript"] as const

interface MediaPart {
  readonly status: "ready" | "pending" | "unavailable" | "failed"
  readonly reason?: string
  readonly url?: string
}

/**
 * What is derived of a video or a sound a version holds, as JSON; with --part, that part's file,
 * downloaded once it is ready.
 */
async function media(api: ApiClient, args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) return writeText(GROUP_HELP.artifacts)
  const { positionals, options } = parseCommandArgs(
    args,
    {
      "--path": "string",
      "--version": "string",
      "--part": "string",
      "--output": "string",
      "--retry": "boolean",
    },
    "artifacts media",
    1
  )

  const path = options["--path"]?.trim()
  if (!path) fail("artifacts media requires --path <file-path>, the video or sound in the version.")
  const version = options["--version"]?.trim() || "latest"
  if (!/^(latest|[1-9]\d*)$/.test(version)) {
    fail('artifacts media --version is a version number, or "latest".')
  }

  const part = options["--part"] && enumValue("--part", options["--part"], MEDIA_FILES)
  const output = options["--output"]
  if (part && !output) fail("artifacts media --part requires --output <local-path>.")

  const route = `/api/artifacts/${idSegment(positionals[0]?.trim())}/versions/${version}/media`
  const derived = (await api.get(route, {
    path,
    ...(options["--retry"] === true ? { retry: "true" } : {}),
  })) as { readonly parts?: Readonly<Record<string, MediaPart>> }
  if (!part || !output) return writeJson(derived)

  const wanted = derived.parts?.[part]
  if (wanted?.status === "pending") {
    fail(
      `The ${part} of ${path} is still being made.`,
      "media_pending",
      "Ask again in a few seconds."
    )
  }
  if (wanted?.status !== "ready" || !wanted.url) {
    fail(
      `${path} has no ${part}: ${wanted?.reason ?? "it was not derived"}`,
      "media_unavailable",
      wanted?.status === "failed"
        ? "Run the command again with --retry to derive it anew."
        : undefined
    )
  }

  const url = new URL(wanted.url, "http://sixb.invalid")
  await api.download(url.pathname, output, Object.fromEntries(url.searchParams))
  return writeJson({ downloaded: true, part, output })
}

function commentsOf(page: unknown): Comment[] {
  const comments =
    typeof page === "object" && page !== null && "comments" in page
      ? (page as { comments: unknown }).comments
      : []
  return Array.isArray(comments)
    ? comments.filter(
        (comment): comment is Comment =>
          typeof comment === "object" && comment !== null && typeof comment.id === "string"
      )
    : []
}

/** The comments as threads, each with its replies, oldest first, of the status asked for. */
function threadsOf(comments: readonly Comment[], status: (typeof STATUSES)[number]) {
  return comments
    .filter((comment) => !comment.parentId)
    .filter(
      (comment) => status === "all" || (status === "resolved") === Boolean(comment.resolvedAt)
    )
    .map((comment) => ({
      ...comment,
      replies: comments.filter((reply) => reply.parentId === comment.id),
    }))
}
