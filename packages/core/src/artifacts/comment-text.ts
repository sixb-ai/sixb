import type { ArtifactCommentAnchor } from "../storage/artifacts/types"
import { placeVideoComment } from "./comment-place"
import type { VideoOutline } from "./outline"

/**
 * A comment as a message to the Agent quotes it: where it is, then its words, as the
 * `sixb-artifacts` skill tells the Agent to read it. `[welcome · body>main:0>h1:0 · "Welcome
 * back" · revision 12 · comment cmt_4k2a9c0d1e · from Ava Martin] Make the title warmer.` A
 * comment on a whole board names no element, and one on the artifact no board; one on a video
 * names its instant in the version read and its scene, `[0:12 · intro · revision 3]`, and one on a
 * scene that version no longer has the scene's label too, `[intro · "Opening" · no longer in the
 * video · revision 3]`. The comment's id lets the Agent resolve it, or reply to it, and its
 * author's name says whose request it is: `from guest Ava Martin` for a shared link's visitor,
 * whose name nobody vouches for. Browser-safe, for the app to draft the message with.
 */
export function quoteArtifactComment(comment: {
  readonly id?: string
  readonly authorName?: string | null
  /** Its author opened a shared link: a guest, without an account. */
  readonly guest?: boolean
  readonly anchor: ArtifactCommentAnchor
  readonly body: string
  /**
   * The version of the video it is on that is read, which places its instant. Without it, an
   * instant within a scene is quoted as how far into it, `0:04 into intro`.
   */
  readonly outline?: VideoOutline
}): string {
  const { anchor } = comment
  const video = [anchor.at, anchor.scene, anchor.offset].some((value) => value !== undefined)
  const where = [
    ...(video
      ? videoPlace(anchor, comment.outline)
      : [anchor.board, anchor.element, anchor.label ? JSON.stringify(anchor.label) : undefined]),
    `revision ${anchor.revision}`,
    comment.id ? `comment ${comment.id}` : undefined,
    comment.authorName
      ? `from ${comment.guest ? "guest " : ""}${comment.authorName.replace(/\s+/g, " ").trim()}`
      : undefined,
  ].filter((part): part is string => part !== undefined)
  return `[${where.join(" · ")}] ${comment.body.replace(/\s+/g, " ").trim()}`
}

/** Where a comment on a video is: its instant and its scene, in the version read when given. */
function videoPlace(
  anchor: ArtifactCommentAnchor,
  outline: VideoOutline | undefined
): (string | undefined)[] {
  if (!outline) {
    if (anchor.offset === undefined) {
      return [anchor.at === undefined ? undefined : clock(anchor.at), anchor.scene]
    }
    return [`${clock(anchor.offset)} into ${anchor.scene}`]
  }

  const place = placeVideoComment(anchor, outline)
  if (place.gone) {
    return [
      anchor.scene,
      anchor.label ? JSON.stringify(anchor.label) : undefined,
      "no longer in the video",
    ]
  }
  return [place.ms === undefined ? undefined : clock(place.ms), place.scene?.id]
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
