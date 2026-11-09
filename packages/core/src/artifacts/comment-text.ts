import type { ArtifactCommentAnchor } from "../storage/artifacts/types"

/**
 * A comment as a message to the Agent quotes it: where it is, then its words, as the
 * `sixb-artifacts` skill tells the Agent to read it. `[welcome · body>main:0>h1:0 · "Welcome
 * back" · revision 12 · comment cmt_4k2a9c0d1e · from Ava Martin] Make the title warmer.` A
 * comment on a whole board names no element, and one on the artifact no board; the comment's id
 * lets the Agent resolve it, or reply to it, and its author's name says whose request it is.
 * Browser-safe, for the app to draft the message with.
 */
export function quoteArtifactComment(comment: {
  readonly id?: string
  readonly authorName?: string | null
  readonly anchor: ArtifactCommentAnchor
  readonly body: string
}): string {
  const { anchor } = comment
  const where = [
    anchor.board,
    anchor.element,
    anchor.label ? JSON.stringify(anchor.label) : undefined,
    `revision ${anchor.revision}`,
    comment.id ? `comment ${comment.id}` : undefined,
    comment.authorName ? `from ${comment.authorName.replace(/\s+/g, " ").trim()}` : undefined,
  ].filter((part): part is string => part !== undefined)
  return `[${where.join(" · ")}] ${comment.body.replace(/\s+/g, " ").trim()}`
}
