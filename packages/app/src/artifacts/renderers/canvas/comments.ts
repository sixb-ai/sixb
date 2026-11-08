import {
  type AddArtifactCommentData,
  addArtifactComment,
  deleteArtifactComment,
  isSixbApiError,
  type ListArtifactCommentsResponse,
  resolveArtifactComment,
} from "@sixb/client"
import { listArtifactCommentsOptions, listArtifactCommentsQueryKey } from "@sixb/client/hooks"
import { quoteArtifactComment } from "@sixb/core/artifacts"
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"
import { useCurrentUser } from "../../../session"
import { useLivePresence } from "../../live/presence"
import type { LiveArtifact } from "../../live/session"
import { useArtifactPeople } from "../../people"

// The comments on a canvas: read once, kept in step as anyone adds, resolves or deletes one, over
// the live socket while the canvas is held live and over the events socket otherwise, and changed
// in place by the reader's own actions, so the panel answers at once.

export type ArtifactComment = ListArtifactCommentsResponse["comments"][number]
export type ArtifactCommentAnchor = ArtifactComment["anchor"]

/** A comment and its replies, oldest first. */
export interface CommentThread {
  readonly comment: ArtifactComment
  readonly replies: readonly ArtifactComment[]
  /** Its place among the canvas's threads, from 1, as its pin shows it. */
  readonly number: number
}

/** Why a comment action failed, in the reader's terms. */
export type CommentFailure = "full" | "invalid" | "notAllowed" | "gone" | "failed"

export class CommentActionError extends Error {
  readonly name = "CommentActionError"

  constructor(readonly failure: CommentFailure) {
    super(`[SixbApp] The comment action failed: ${failure}.`)
  }
}

/** The threads of these comments, in the order they were started; replies under each. */
export function commentThreads(comments: readonly ArtifactComment[]): CommentThread[] {
  const replies = new Map<string, ArtifactComment[]>()
  for (const comment of comments) {
    if (!comment.parentId) continue
    const list = replies.get(comment.parentId) ?? []
    list.push(comment)
    replies.set(comment.parentId, list)
  }

  return comments
    .filter((comment) => !comment.parentId)
    .map((comment, index) => ({
      comment,
      replies: replies.get(comment.id) ?? [],
      number: index + 1,
    }))
}

const NO_COMMENTS: readonly ArtifactComment[] = []

/**
 * The comments on an artifact, as threads, read again whenever someone changes one: the live
 * artifact says so while the canvas is held live; the events socket otherwise.
 */
export function useArtifactComments(
  artifactId: string | null,
  live: LiveArtifact | null
): {
  readonly threads: readonly CommentThread[]
  readonly loading: boolean
  readonly failed: boolean
} {
  const queries = useQueryClient()
  const query = useQuery({
    ...listArtifactCommentsOptions({ path: { artifactId: artifactId ?? "" } }),
    enabled: artifactId !== null,
    retry: false,
  })

  useEffect(() => {
    if (!live || !artifactId) return
    return live.onCommented(() => {
      void queries.invalidateQueries({ queryKey: commentsKey(artifactId) })
    })
  }, [live, artifactId, queries])

  const comments = query.data?.comments ?? NO_COMMENTS
  const threads = useMemo(() => commentThreads(comments), [comments])
  return { threads, loading: query.isLoading, failed: query.isError }
}

function commentsKey(artifactId: string) {
  return listArtifactCommentsQueryKey({ path: { artifactId } })
}

/** Changes the cached comments of an artifact, as a change the reader made shows at once. */
function updateCached(
  queries: QueryClient,
  artifactId: string,
  update: (comments: readonly ArtifactComment[]) => readonly ArtifactComment[]
): void {
  queries.setQueryData<ListArtifactCommentsResponse>(commentsKey(artifactId), (current) =>
    current ? { ...current, comments: [...update(current.comments)] } : current
  )
}

/** Adds a comment, or a reply, as the reader; it shows in the panel as soon as it is taken. */
export async function addComment(
  queries: QueryClient,
  artifactId: string,
  body: AddArtifactCommentData["body"]
): Promise<ArtifactComment> {
  try {
    const { data } = await addArtifactComment({
      path: { artifactId },
      body,
      throwOnError: true,
    })
    updateCached(queries, artifactId, (comments) =>
      comments.some((comment) => comment.id === data.id) ? comments : [...comments, data]
    )
    return data
  } catch (error) {
    throw commentError(error)
  }
}

/** Marks a comment resolved, or opens it again. */
export async function resolveComment(
  queries: QueryClient,
  artifactId: string,
  commentId: string,
  resolved: boolean
): Promise<void> {
  try {
    const { data } = await resolveArtifactComment({
      path: { artifactId, commentId },
      body: { resolved },
      throwOnError: true,
    })
    updateCached(queries, artifactId, (comments) =>
      comments.map((comment) => (comment.id === data.id ? data : comment))
    )
  } catch (error) {
    throw commentError(error)
  }
}

/** Deletes a comment and its replies. */
export async function deleteComment(
  queries: QueryClient,
  artifactId: string,
  commentId: string
): Promise<void> {
  try {
    await deleteArtifactComment({ path: { artifactId, commentId }, throwOnError: true })
    updateCached(queries, artifactId, (comments) =>
      comments.filter((comment) => comment.id !== commentId && comment.parentId !== commentId)
    )
  } catch (error) {
    throw commentError(error)
  }
}

function commentError(error: unknown): CommentActionError {
  if (!isSixbApiError(error)) return new CommentActionError("failed")
  switch (error.code) {
    case "comments_full":
      return new CommentActionError("full")
    case "invalid_comment":
      return new CommentActionError("invalid")
    case "not_allowed":
      return new CommentActionError("notAllowed")
    case "comment_not_found":
    case "artifact_not_found":
      return new CommentActionError("gone")
    default:
      return new CommentActionError("failed")
  }
}

/**
 * Whether the reader may resolve or delete a comment: its author, or whoever may change the
 * artifact, as the API decides.
 */
export function canManageComment(
  comment: Pick<ArtifactComment, "author">,
  access: "owner" | "update" | "read",
  userId: string | null
): boolean {
  if (access === "owner" || access === "update") return true
  return comment.author.type === "user" && comment.author.id === userId
}

/**
 * Who wrote a comment, as the reader can tell: themselves, someone of the conversation the canvas
 * opens in, or someone on the canvas now. Null for someone the reader cannot name.
 */
export function useCommentAuthors(
  live: LiveArtifact | null
): (author: ArtifactComment["author"]) => { readonly name: string; readonly you: boolean } | null {
  const user = useCurrentUser()
  const nameOf = useArtifactPeople()
  const { peers } = useLivePresence(live)

  return (author) => {
    if (author.type === "user" && author.id === user?.id) {
      return { name: user.displayName ?? user.email ?? "", you: true }
    }
    const known = nameOf(author)
    if (known) return { name: known, you: false }

    const peer = peers.find((each) => each.user.id === `${author.type}:${author.id}`)
    return peer ? { name: peer.user.name, you: false } : null
  }
}

/**
 * The message that asks the Agent to act on these comments: a line that says so, then each
 * comment quoted with where it is, as the Agent's skill reads them.
 */
export function agentDraftOf(intro: string, threads: readonly CommentThread[]): string {
  const quoted = threads.map(({ comment, replies }) => {
    const lines = [`- ${quoteArtifactComment(comment)}`]
    for (const reply of replies) lines.push(`  - ${reply.body.replace(/\s+/g, " ").trim()}`)
    return lines.join("\n")
  })
  return [intro, ...quoted].join("\n")
}
