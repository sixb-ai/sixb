import type { ArtifactCommentAnchor } from "../storage/artifacts/types"

/**
 * A comment as a message to the Agent quotes it: where it is, then its words, as the
 * `sixb-artifacts` skill tells the Agent to read it. `[welcome · body>main:0>h1:0 · "Welcome
 * back" · revision 12 · comment cmt_4k2a9c0d1e · from Ava Martin] Make the title warmer.` A
 * comment on a whole board names no element, and one on the artifact no board; one on a video
 * names its instant and its scene, `[0:12 · intro · revision 3]`. The comment's id lets the Agent
 * resolve it, or reply to it, and its author's name says whose request it is: `from guest Ava
 * Martin` for a shared link's visitor, whose name nobody vouches for. Browser-safe, for the app to
 * draft the message with.
 */
export function quoteArtifactComment(comment: {
  readonly id?: string
  readonly authorName?: string | null
  /** Its author opened a shared link: a guest, without an account. */
  readonly guest?: boolean
  readonly anchor: ArtifactCommentAnchor
  readonly body: string
}): string {
  const { anchor } = comment
  const where = [
    anchor.at === undefined ? undefined : clock(anchor.at),
    anchor.scene,
    anchor.board,
    anchor.element,
    anchor.label ? JSON.stringify(anchor.label) : undefined,
    `revision ${anchor.revision}`,
    comment.id ? `comment ${comment.id}` : undefined,
    comment.authorName
      ? `from ${comment.guest ? "guest " : ""}${comment.authorName.replace(/\s+/g, " ").trim()}`
      : undefined,
  ].filter((part): part is string => part !== undefined)
  return `[${where.join(" · ")}] ${comment.body.replace(/\s+/g, " ").trim()}`
}

/** An instant as a player shows it: `m:ss`, or `h:mm:ss` past an hour. */
function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = String(seconds % 60).padStart(2, "0")
  return minutes < 60
    ? `${minutes}:${rest}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`
}
