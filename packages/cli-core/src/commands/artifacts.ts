import type { ApiClient } from "../api-client"
import { enumValue, isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { idSegment, readText } from "./shared"

// An artifact's comments, as the people reading it leave them: read them as threads, resolve the
// ones whose change is made, and reply to one to say why it is not. The Agent's run reaches them
// as the person it answers, through the conversation that shares the artifact.

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
