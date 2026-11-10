import { type AgentContextInput, MAX_AGENT_APP_STATE_ENTRY_BYTES } from "@sixb/core/agents/context"
import { quoteArtifactComment } from "@sixb/core/artifacts"

// The comments a reader sends the Agent, as context of their message: a chip that names how many
// and on what, and that shows their words; for the Agent, each comment quoted with where it is,
// its id and its author, as its skill reads them. What the reader reads stays words, never the
// addresses and ids the Agent needs.

/** What a comments context's id starts with, before the artifact's id. */
export const COMMENTS_CONTEXT_PREFIX = "artifact-comments:"

/** One comment as the context holds it: quoted for the Agent, its words for the chip. */
export interface ContextComment {
  readonly id: string
  readonly quote: string
  readonly author: string | null
  readonly body: string
  readonly replies: readonly string[]
}

/** What a comments context holds. */
export interface CommentsContextValue {
  readonly artifactId: string
  readonly title: string
  readonly comments: readonly ContextComment[]
}

/** What a comment brings to the context: itself and its replies, as the API gives them. */
interface SentComment {
  readonly id: string
  readonly anchor: Parameters<typeof quoteArtifactComment>[0]["anchor"]
  readonly body: string
  readonly authorName?: string | null
  readonly author?: { readonly type: string }
}

/** Room left in the context for what its id, label and description take. */
const CONTEXT_ROOM_BYTES = MAX_AGENT_APP_STATE_ENTRY_BYTES - 2 * 1024

/** The longest words of a comment or a reply the context keeps. */
const MAX_WORDS = 1_500

/**
 * The context that sends these comments to the Agent, labelled for the chip. As many as fit in a
 * context entry go, in order; `sent` says how many.
 */
export function commentsContext(input: {
  readonly artifactId: string
  readonly title: string
  readonly label: (count: number) => string
  readonly threads: readonly {
    readonly comment: SentComment
    readonly replies: readonly SentComment[]
  }[]
}): { readonly context: AgentContextInput; readonly sent: number } {
  const comments: ContextComment[] = []
  let bytes = 0
  for (const { comment, replies } of input.threads) {
    const body = cut(comment.body)
    const entry: ContextComment = {
      id: comment.id,
      quote: quoteArtifactComment({ ...comment, body, guest: comment.author?.type === "guest" }),
      author: comment.authorName ?? null,
      body,
      replies: replies.map((reply) => cut(reply.body)),
    }
    const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength
    if (comments.length > 0 && bytes + size > CONTEXT_ROOM_BYTES) break
    comments.push(entry)
    bytes += size
  }

  const value = {
    artifactId: input.artifactId,
    title: input.title,
    comments: comments.map((comment) => ({ ...comment, replies: [...comment.replies] })),
  }
  return {
    sent: comments.length,
    context: {
      kind: "app-state",
      id: `${COMMENTS_CONTEXT_PREFIX}${input.artifactId}`,
      label: input.label(comments.length),
      description: `Comments the person chose on the canvas "${input.title}" (${input.artifactId}) for you to address. Each quote names where the comment is, as the canvas guide of the sixb-artifacts skill explains, then its words; replies follow it.`,
      value,
    },
  }
}

/** The comments a context sends, when it is a comments context; null for any other. */
export function readCommentsContext(context: AgentContextInput): CommentsContextValue | null {
  if (context.kind !== "app-state" || !context.id.startsWith(COMMENTS_CONTEXT_PREFIX)) return null
  const value = context.value
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null

  const comments = (value as Record<string, unknown>).comments
  if (!Array.isArray(comments)) return null
  const read = comments.flatMap((comment): ContextComment[] => {
    if (typeof comment !== "object" || comment === null || Array.isArray(comment)) return []
    const { id, quote, author, body, replies } = comment as Record<string, unknown>
    if (typeof id !== "string" || typeof quote !== "string" || typeof body !== "string") return []
    return [
      {
        id,
        quote,
        author: typeof author === "string" ? author : null,
        body,
        replies: Array.isArray(replies)
          ? replies.filter((reply): reply is string => typeof reply === "string")
          : [],
      },
    ]
  })
  const { artifactId, title } = value as Record<string, unknown>
  return {
    artifactId: typeof artifactId === "string" ? artifactId : "",
    title: typeof title === "string" ? title : "",
    comments: read,
  }
}

function cut(words: string): string {
  const text = words.replace(/\s+/g, " ").trim()
  return text.length > MAX_WORDS ? `${text.slice(0, MAX_WORDS - 1)}…` : text
}
