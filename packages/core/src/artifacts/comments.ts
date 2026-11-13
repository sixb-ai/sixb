import type { Principal } from "../auth"
import { principalsEqual } from "../auth"
import type { DomainEventLog } from "../events/service"
import { ArtifactStorageError } from "../storage/artifacts/errors"
import type {
  ArtifactCommentAnchor,
  ArtifactCommentAuthor,
  ArtifactCommentRecord,
  ArtifactOrigin,
  ArtifactRecord,
  ArtifactStorage,
} from "../storage/artifacts/types"
import type { ArtifactAccess } from "./access"
import { ArtifactRequestError } from "./errors"
import { announceArtifactComment } from "./events"
import { createArtifactCommentId } from "./ids"
import { ARTIFACT_COMMENT_LIMITS } from "./limits"

// Comments on an artifact: whoever reads it reads and adds them, a shared link's guest included;
// their author, or whoever may change the artifact, resolves or deletes them, and only the latter a
// guest's. Each change is announced to its readers.
//
// A thread is the team's unless a guest started it. A guest reads only the threads started by a
// guest of the same link, themselves or whoever else opened it, with every reply, a member's
// included: the team's threads are missing to them, as if there were none.

/** A comment to add, or a reply. */
export interface ArtifactCommentInput {
  /** Plain text. */
  readonly body: string
  /**
   * What it is about: a canvas's board by its item id, an element of the board by the address
   * `boardElements` gives it, with its first words as `label`, or, without, the artifact. At the
   * revision its author saw, the artifact's by default. A reply is about what it replies to.
   */
  readonly anchor?: Partial<ArtifactCommentAnchor>
  /** The comment this one replies to. */
  readonly parentId?: string
  /** The Agent's run that writes it for the caller, and that run's conversation. */
  readonly origin?: ArtifactOrigin
}

/** The comment methods of the artifacts runtime. */
export interface ArtifactCommentsRuntime {
  /**
   * Every comment and reply the caller reads, oldest first: a shared link's guest, only its link's
   * threads. `null` when the caller cannot read the artifact.
   */
  listComments(artifactId: string): Promise<ArtifactCommentRecord[] | null>
  /**
   * Adds a comment, or a reply, authored by the caller, who must read the artifact. A shared link's
   * guest writes it under the name they gave, and is refused with `name_required` until they give
   * one. Throws `invalid_comment` for words or an anchor that will not do, `comment_not_found` for
   * a reply to no comment the caller reads, and `comments_full`.
   */
  addComment(artifactId: string, input: ArtifactCommentInput): Promise<ArtifactCommentRecord>
  /**
   * Marks a comment resolved, or opens it again. Its author or whoever may change the artifact
   * may: anyone else, and every guest, is refused with `not_allowed`, or `comment_not_found` for a
   * guest's comment they do not read.
   */
  resolveComment(
    artifactId: string,
    commentId: string,
    resolved?: boolean
  ): Promise<ArtifactCommentRecord>
  /** Deletes a comment and its replies, as `resolveComment` allows. */
  deleteComment(artifactId: string, commentId: string): Promise<void>
}

/** An element's address, as `boardElements` writes it, and the longest one a comment keeps. */
const ELEMENT_ADDRESS = /^body(>[a-z][a-z0-9-]*:\d+)*$/
const MAX_ELEMENT_ADDRESS_LENGTH = 1024

export function createArtifactCommentsRuntime(input: {
  readonly projectId: string
  readonly storage: () => ArtifactStorage
  readonly events: Pick<DomainEventLog, "emit">
  /** Who writes a comment the caller adds. */
  readonly author: () => Promise<ArtifactCommentAuthor>
  /** Who resolves or deletes one; throws `not_allowed` for a caller who never may. */
  readonly manager: () => Principal
  /**
   * For a shared link's guest, the link they came through, by its grant: they read only the
   * threads its guests started. Without it, a member reads every thread.
   */
  readonly guest?: { readonly grantId?: string }
  readonly reach: (
    artifactId: string
  ) => Promise<{ readonly artifact: ArtifactRecord; readonly access: ArtifactAccess } | null>
}): ArtifactCommentsRuntime {
  const { projectId, events, guest } = input

  /** The thread a comment is in: the comment itself, or the one it replies to. */
  const threadOf = (comment: ArtifactCommentRecord) =>
    comment.parentId === undefined
      ? Promise.resolve(comment)
      : input
          .storage()
          .getComment({ projectId, artifactId: comment.artifactId, id: comment.parentId })

  /** Whether the caller reads this thread: a member every one, a guest only its link's. */
  const reads = (thread: ArtifactCommentRecord | null): thread is ArtifactCommentRecord =>
    thread !== null &&
    (!guest || (guest.grantId !== undefined && threadLink(thread) === guest.grantId))

  /** The artifact the caller reads; refused with why otherwise. */
  const readable = async (artifactId: string) => {
    const reached = await input.reach(artifactId)
    if (!reached) throw notFound(artifactId)
    if (reached.access === "none") {
      throw new ArtifactRequestError(
        "not_shared",
        `[Sixb] Artifact '${artifactId}' is not shared with you.`
      )
    }
    return reached
  }

  /**
   * A comment the caller may resolve or delete, with its thread: theirs, or one on an artifact they
   * may change. One in a thread they do not read is missing.
   */
  const managed = async (artifactId: string, commentId: string) => {
    const { access } = await readable(artifactId)
    const comment = await input.storage().getComment({ projectId, artifactId, id: commentId })
    const thread = comment ? await threadOf(comment) : null
    if (!comment || !reads(thread)) throw commentNotFound(artifactId, commentId)
    const manager = input.manager()

    // A guest's comment is managed by those who may change the artifact, never by a guest.
    const changes = access === "owner" || access === "update"
    const authored = comment.author.type !== "guest" && principalsEqual(comment.author, manager)
    if (!changes && !authored) {
      throw new ArtifactRequestError(
        "not_allowed",
        "[Sixb] Only a comment's author, or whoever may change the artifact, resolves or deletes it."
      )
    }
    return { comment, thread }
  }

  return {
    async listComments(artifactId) {
      const reached = await input.reach(artifactId)
      if (!reached || reached.access === "none") return null

      const comments = await input.storage().listComments({ projectId, id: artifactId })
      if (!guest) return comments

      const threads = new Set(
        comments
          .filter((comment) => comment.parentId === undefined && reads(comment))
          .map((comment) => comment.id)
      )
      return comments.filter((comment) => threads.has(comment.parentId ?? comment.id))
    },

    async addComment(artifactId, comment) {
      const { artifact } = await readable(artifactId)
      const author = await input.author()
      const storage = input.storage()

      const body = comment.body.trim()
      if (body.length === 0 || body.length > ARTIFACT_COMMENT_LIMITS.maxBodyLength) {
        throw invalid(
          `A comment holds 1 to ${ARTIFACT_COMMENT_LIMITS.maxBodyLength} characters of text.`
        )
      }

      // A reply is about what it replies to, in a thread the caller reads.
      let anchor: ArtifactCommentAnchor
      let parent: ArtifactCommentRecord | null = null
      if (comment.parentId !== undefined) {
        parent = await storage.getComment({ projectId, artifactId, id: comment.parentId })
        if (!reads(parent)) throw commentNotFound(artifactId, comment.parentId)
        anchor = parent.anchor
      } else {
        anchor = await checkAnchor(storage, artifact, comment.anchor ?? {})
      }

      try {
        const created = await storage.createComment({
          projectId,
          artifactId,
          id: createArtifactCommentId(),
          ...(comment.parentId === undefined ? {} : { parentId: comment.parentId }),
          anchor,
          body,
          author,
          ...(comment.origin ? { origin: comment.origin } : {}),
          createdAt: new Date(),
        })
        await announceArtifactComment(events, created, threadLink(parent ?? created), "created")
        return created
      } catch (error) {
        throw commentRequestError(error)
      }
    },

    async resolveComment(artifactId, commentId, resolved = true) {
      const { thread } = await managed(artifactId, commentId)
      const changed = await input.storage().resolveComment({
        projectId,
        artifactId,
        id: commentId,
        resolved: resolved ? { at: new Date(), by: input.manager() } : null,
      })
      if (!changed) throw commentNotFound(artifactId, commentId)

      await announceArtifactComment(
        events,
        changed,
        threadLink(thread),
        resolved ? "resolved" : "reopened"
      )
      return changed
    },

    async deleteComment(artifactId, commentId) {
      const { comment, thread } = await managed(artifactId, commentId)
      const deleted = await input.storage().deleteComment({ projectId, artifactId, id: commentId })
      if (!deleted) throw commentNotFound(artifactId, commentId)

      await announceArtifactComment(events, comment, threadLink(thread), "deleted")
    },
  }
}

/**
 * The shared link whose guests read a thread, by its grant: the one its first comment's guest came
 * through. None for a thread a member started, which is the team's.
 */
function threadLink(thread: Pick<ArtifactCommentRecord, "author">): string | undefined {
  return thread.author.type === "guest" ? thread.author.grantId : undefined
}

/**
 * The anchor as it is kept: a board the canvas's latest version shows, an element's address
 * under it, its label cut to length, and a revision the artifact has had.
 */
async function checkAnchor(
  storage: ArtifactStorage,
  artifact: ArtifactRecord,
  anchor: Partial<ArtifactCommentAnchor>
): Promise<ArtifactCommentAnchor> {
  const revision = anchor.revision ?? artifact.revision
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > artifact.revision) {
    throw invalid(`A comment is about a revision of the artifact, 1 to ${artifact.revision}.`)
  }

  if (anchor.element !== undefined && anchor.board === undefined) {
    throw invalid("A comment on an element names the board it is on.")
  }
  if (
    anchor.element !== undefined &&
    (anchor.element.length > MAX_ELEMENT_ADDRESS_LENGTH || !ELEMENT_ADDRESS.test(anchor.element))
  ) {
    throw invalid(`'${anchor.element}' is no element's address, as a board's elements have.`)
  }
  if (anchor.board !== undefined) {
    const latest = await storage.getVersion({
      projectId: artifact.projectId,
      artifactId: artifact.id,
      version: artifact.latestVersion,
    })
    const outline = latest?.outline
    const shows =
      outline?.kind === "canvas" &&
      outline.items.some((item) => item.type === "board" && item.id === anchor.board)
    if (!shows) throw invalid(`The artifact shows no board '${anchor.board}'.`)
  }

  const { point } = anchor
  if (point !== undefined && anchor.board === undefined) {
    throw invalid("A comment's point is on the board it names.")
  }
  if (
    point !== undefined &&
    ![point.x, point.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
  ) {
    throw invalid("A comment's point is on its board: x and y from 0 to 1.")
  }

  const label = anchor.label
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, ARTIFACT_COMMENT_LIMITS.maxLabelLength)
  return {
    ...(anchor.board === undefined ? {} : { board: anchor.board }),
    ...(anchor.element === undefined ? {} : { element: anchor.element }),
    ...(label ? { label } : {}),
    ...(point === undefined ? {} : { point: { x: point.x, y: point.y } }),
    revision,
  }
}

function commentRequestError(error: unknown): unknown {
  if (!(error instanceof ArtifactStorageError)) return error
  switch (error.code) {
    case "artifact_not_found":
      return new ArtifactRequestError("artifact_not_found", error.message)
    case "comment_not_found":
      return new ArtifactRequestError("comment_not_found", error.message)
    case "artifact_comments_full":
      return new ArtifactRequestError("comments_full", error.message)
    default:
      return error
  }
}

function invalid(message: string): ArtifactRequestError {
  return new ArtifactRequestError("invalid_comment", `[Sixb] ${message}`)
}

function notFound(artifactId: string): ArtifactRequestError {
  return new ArtifactRequestError(
    "artifact_not_found",
    `[Sixb] Artifact '${artifactId}' was not found.`
  )
}

function commentNotFound(artifactId: string, commentId: string): ArtifactRequestError {
  return new ArtifactRequestError(
    "comment_not_found",
    `[Sixb] Artifact '${artifactId}' has no comment '${commentId}'.`
  )
}
