import type { ArtifactCommentAnchor } from "../storage/artifacts/types"

/**
 * A comment as a message to the Agent quotes it: where it is, then its words, as the
 * `sixb-artifacts` skill tells the Agent to read it. `[welcome · body>main:0>h1:0 · "Welcome
 * back" · revision 12] Make the title warmer.` A comment on a whole board names no element, and
 * one on the artifact no board. Browser-safe, for the app to draft the message with.
 */
export function quoteArtifactComment(comment: {
  readonly anchor: ArtifactCommentAnchor
  readonly body: string
}): string {
  const { anchor } = comment
  const where = [
    anchor.board,
    anchor.element,
    anchor.label ? JSON.stringify(anchor.label) : undefined,
    `revision ${anchor.revision}`,
  ].filter((part): part is string => part !== undefined)
  return `[${where.join(" · ")}] ${comment.body.replace(/\s+/g, " ").trim()}`
}
