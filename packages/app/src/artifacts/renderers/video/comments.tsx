import {
  placeVideoComment,
  type VideoCommentPlace,
  type VideoOutline,
  videoSceneAt,
} from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { type CSSProperties, useCallback, useMemo, useState } from "react"
import { type CommentPlace, listed, useArtifactCommenting } from "../../comments/commenting"
import type { CommentThread } from "../../comments/comments"
import { CommentPin, cardPlace, DraftCard } from "../../comments/composer"
import { useArtifactMessages } from "../../messages"
import { formatClock } from "../../playback"
import { chapterName } from "./chapters"

// Comments at an instant of a video: placed by a click on the paused frame, each keeps the scene
// playing then, how far into it, and the point clicked. Each is placed in the version shown as
// core places it: its pin shows on the frame while the playhead is at its instant, its mark sits on
// the track, and the panel lists them in the order they come. One on a scene the version no longer
// has keeps its place in the panel, with no instant to go to.

/** How long after its instant a comment's pin stays on the frame as the video plays on. */
const PIN_SECONDS = 1.5

/** How much of a comment its mark on the track shows. */
const EXCERPT_LENGTH = 48

/**
 * A pin on the video, whatever the app's theme: white with a dark edge, the open one in the
 * selection blue the frames' editing uses, so each stands out on any picture.
 */
const PIN_ON_VIDEO = {
  "--background": "#0b0b0b",
  "--foreground": "#ffffff",
  "--muted": "#4a4a4a",
  "--muted-foreground": "#e5e5e5",
  "--primary": "#0a84ff",
  "--primary-foreground": "#ffffff",
} as CSSProperties

/** A point on the frame, as fractions of its width and height. */
export interface FramePoint {
  readonly x: number
  readonly y: number
}

/** A new comment, while it is written: its instant, in milliseconds, and where on the frame. */
export interface VideoCommentDraft {
  readonly at: number
  readonly point: FramePoint
}

export function useVideoCommenting({
  artifactId,
  title,
  revision,
  outline,
}: {
  readonly artifactId: string | null
  readonly title: string
  readonly revision: number
  readonly outline: VideoOutline
}) {
  const commenting = useArtifactCommenting({ artifactId, kind: "video", title, revision, outline })
  const { add, setCommenting, filter, pinLabel } = commenting
  const [draft, setDraft] = useState<VideoCommentDraft | null>(null)

  // Each thread placed once in the version shown.
  const places = useMemo(
    () =>
      new Map(
        commenting.threads.map(
          (thread) =>
            [thread.comment.id, placeVideoComment(thread.comment.anchor, outline)] as const
        )
      ),
    [commenting.threads, outline]
  )
  const placeOf = useCallback(
    (thread: CommentThread): VideoCommentPlace => places.get(thread.comment.id) ?? {},
    [places]
  )

  // Numbered in the order they come in the video, as the panel lists them; those with no instant
  // last, in the order they were written.
  const threads = useMemo(
    () =>
      [...commenting.threads]
        .sort(
          (a, b) =>
            (placeOf(a).ms ?? Number.POSITIVE_INFINITY) -
              (placeOf(b).ms ?? Number.POSITIVE_INFINITY) || a.number - b.number
        )
        .map((thread, index) => ({ ...thread, number: index + 1 })),
    [commenting.threads, placeOf]
  )

  const submitDraft = useCallback(
    async (body: string) => {
      if (!draft) return
      await add(draftAnchor(outline, draft), body)
      setDraft(null)
      setCommenting(false)
    },
    [draft, add, outline, setCommenting]
  )

  /** The threads the panel lists with an instant, as marks on the track. */
  const marked = useMemo(
    () =>
      threads.flatMap((thread) => {
        const { ms } = placeOf(thread)
        if (ms === undefined || !listed(thread, filter)) return []
        return [{ thread, seconds: ms / 1000, label: pinLabel(thread), excerpt: excerpt(thread) }]
      }),
    [threads, filter, pinLabel, placeOf]
  )

  return {
    ...commenting,
    threads,
    placeOf,
    marked,
    draft,
    place: (seconds: number, point: FramePoint) =>
      setDraft({ at: Math.round(seconds * 1000), point }),
    cancelDraft: () => setDraft(null),
    submitDraft,
    toggleCommenting: () => {
      setCommenting((current) => !current)
      setDraft(null)
    },
  }
}

export type VideoCommenting = ReturnType<typeof useVideoCommenting>

/**
 * Where a thread is on the video: its instant and its scene, a whole scene, or the whole video. One
 * on a scene the version no longer has names it struck through, and says so.
 */
export function ThreadInstant({
  thread,
  place,
  outline,
}: {
  readonly thread: CommentThread
  /** Where it is in the version shown, as `placeVideoComment` places it. */
  readonly place: VideoCommentPlace
  readonly outline: VideoOutline
}) {
  const messages = useArtifactMessages().video
  if (place.gone) {
    const { label, scene } = thread.comment.anchor
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
        <span className="min-w-0 truncate line-through decoration-1">
          {label ? `“${label}”` : scene}
        </span>
        <span className="rounded-sm bg-muted px-1 text-[10.5px] text-muted-foreground">
          {messages.sceneGone}
        </span>
      </span>
    )
  }

  if (place.ms === undefined) {
    return (
      <span className="font-medium text-foreground/80">
        {place.scene ? chapterName(place.scene) : messages.wholeVideo}
      </span>
    )
  }

  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="rounded-md bg-muted px-1.5 font-medium text-foreground tabular-nums">
        {formatClock(place.ms / 1000)}
      </span>
      {place.scene && outline.scenes.length > 1 ? (
        <span className="min-w-0 truncate">{chapterName(place.scene)}</span>
      ) : null}
    </span>
  )
}

/**
 * The pins of the comments at the instant the frame shows, at the points they were placed, and the
 * new comment's pin and card: drawn over the frame in its own pixels, `width` by `height`.
 */
export function VideoCommentPins({
  commenting,
  outline,
  time,
  width,
  height,
  onOpen,
}: {
  readonly commenting: VideoCommenting
  readonly outline: VideoOutline
  readonly time: number
  readonly width: number
  readonly height: number
  readonly onOpen: (thread: CommentThread) => void
}) {
  const { comments: messages, video } = useArtifactMessages()
  const { marked, active, draft } = commenting

  // Only around its instant, the open one too: elsewhere a pin would point at another scene.
  const shown = marked.filter(
    ({ seconds }) => time >= seconds - 0.05 && time <= seconds + PIN_SECONDS
  )
  let unplaced = 0

  return (
    <div className="pointer-events-none absolute inset-0">
      {shown.map(({ thread, label }) => {
        const { point } = thread.comment.anchor
        // A comment with no point, as the Agent may leave, sits at the frame's top right.
        const at = point ?? { x: 1, y: 0.04 + unplaced++ * 0.1 }
        return (
          <div
            key={thread.comment.id}
            className="absolute"
            style={{
              ...PIN_ON_VIDEO,
              left: at.x * width - (point ? 0 : 36),
              top: at.y * height + (point ? 0 : 30),
            }}
          >
            <CommentPin
              number={thread.number}
              label={label}
              active={thread.comment.id === active}
              resolved={Boolean(thread.comment.resolvedAt)}
              onClick={() => onOpen(thread)}
            />
          </div>
        )
      })}

      {draft ? (
        <div
          className="absolute"
          style={{ left: draft.point.x * width, top: draft.point.y * height }}
        >
          <span style={PIN_ON_VIDEO}>
            <CommentPin label={messages.newPin} active resolved={false} draft />
          </span>
          <div
            className={cn("absolute z-10", draft.point.y > 0.55 ? "bottom-9" : "top-1")}
            style={cardPlace(draft.point.x * width, width)}
          >
            <DraftCard
              heading={draftPlace(outline, draft.at, video.at)}
              onSubmit={commenting.submitDraft}
              onCancel={commenting.cancelDraft}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * What a new comment is about: its instant, the scene playing then, and the point clicked. Between
 * two scenes, or past the last, it names none: no scene plays there.
 */
export function draftAnchor(outline: VideoOutline, draft: VideoCommentDraft): CommentPlace {
  const scene = videoSceneAt(outline, draft.at)
  return { at: draft.at, ...(scene ? { scene: scene.id } : {}), point: draft.point }
}

/** A comment's first words, on one line. */
function excerpt(thread: CommentThread): string {
  const words = thread.comment.body.replace(/\s+/g, " ").trim()
  return words.length > EXCERPT_LENGTH ? `${words.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : words
}

/**
 * Where a new comment goes, as its card says it: at its instant, and its scene when there are
 * more. `at` words the instant.
 */
function draftPlace(outline: VideoOutline, ms: number, at: (time: string) => string): string {
  const time = at(formatClock(ms / 1000))
  const scene = outline.scenes.length > 1 ? videoSceneAt(outline, ms) : undefined
  return scene ? `${time} · ${chapterName(scene)}` : time
}
