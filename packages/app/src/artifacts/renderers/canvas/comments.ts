import {
  type AddArtifactCommentData,
  addArtifactComment,
  deleteArtifactComment,
  isSixbApiError,
  type ListArtifactCommentsResponse,
  resolveArtifactComment,
} from "@sixb/client"
import { listArtifactCommentsOptions, listArtifactCommentsQueryKey } from "@sixb/client/hooks"
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"
import { useCurrentUser } from "../../../session"
import type { LiveArtifact } from "../../live/session"
import { useArtifactMessages } from "../../messages"

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

/** Who wrote a comment, as the panel says it. */
export interface CommentAuthor {
  readonly name: string
  readonly you: boolean
  /** The Agent wrote it, for its author. */
  readonly agent?: boolean
}

/**
 * Who wrote a comment: the reader themselves, else the name the API gives its author, and the
 * Agent for them when its run wrote it. Null for an author the project cannot name.
 */
export function useCommentAuthors(): (
  comment: Pick<ArtifactComment, "author" | "authorName" | "origin">
) => CommentAuthor | null {
  const user = useCurrentUser()
  const messages = useArtifactMessages().canvas.comments

  return ({ author, authorName, origin }) => {
    const own = author.type === "user" && author.id === user?.id
    if (origin) {
      const name = own ? messages.you.toLowerCase() : (authorName ?? messages.someone)
      return { name: messages.agentFor(name), you: false, agent: true }
    }
    if (own) return { name: user.displayName ?? user.email ?? authorName ?? "", you: true }
    return authorName ? { name: authorName, you: false } : null
  }
}
