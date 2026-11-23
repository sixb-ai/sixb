import type { VideoClip, VideoSources } from "@sixb/core/artifacts/live"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { AudioLines, Check, Image as ImageIcon, Upload, Video } from "lucide-react"
import { useRef } from "react"
import { artifactFileSource } from "../../../file-source"
import { useArtifactMessages } from "../../../messages"
import { importKind } from "./import"
import { type MediaTarget, useMediaParts } from "./media"
import { FilmstripFrame } from "./scenes"
import { clipName } from "./selection"

// Replace with…: the files of the video a clip may play in its place, of its kind, each with a
// picture of it, and a file of one's own to upload. The clip keeps its start, its length, its
// sound and its look; every part of a clip that goes on plays the new file on.

/** The files of the video of a kind, by their paths: footage, sounds or pictures. */
export function mediaOfKind(sources: VideoSources, kind: VideoClip["kind"]): string[] {
  return [...sources]
    .filter(([path, text]) => text === null && importKind({ type: "", name: path }) === kind)
    .map(([path]) => path)
    .sort((a, b) => a.localeCompare(b))
}

export function ReplaceDialog({
  clip,
  media,
  target,
  onChoose,
  onUpload,
  onClose,
}: {
  /** The clip whose file is replaced; none while the dialog is closed. */
  readonly clip: VideoClip | null
  /** The files of its kind the video holds. */
  readonly media: readonly string[]
  readonly target: MediaTarget
  readonly onChoose: (path: string) => void
  readonly onUpload: (file: File) => void
  readonly onClose: () => void
}) {
  const messages = useArtifactMessages().videoEditor
  const input = useRef<HTMLInputElement | null>(null)
  const kind = clip?.kind
  const playing = clip?.src?.replace(/^(\.\.\/)+/, "")

  return (
    <Dialog open={clip !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{clip ? messages.replaceTitle(clipName(clip)) : null}</DialogTitle>
          <DialogDescription>{messages.replaceHint}</DialogDescription>
        </DialogHeader>

        {media.length > 0 ? (
          <ul className="m-0 grid max-h-[50vh] list-none grid-cols-3 gap-2.5 overflow-y-auto p-0">
            {media.map((path) => (
              <li key={path}>
                <MediaChoice
                  path={path}
                  kind={kind}
                  current={path === playing}
                  target={target}
                  onChoose={() => onChoose(path)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-[13px] text-muted-foreground">{messages.noOtherMedia}</p>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
            <Upload />
            {messages.uploadMedia}
          </Button>
          <input
            ref={input}
            type="file"
            hidden
            accept={kind === "video" ? "video/*" : kind === "audio" ? "audio/*" : "image/*"}
            aria-label={messages.uploadMedia}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ""
              if (file) onUpload(file)
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** A file to choose: a picture of it, and its name. The one the clip plays now is marked. */
function MediaChoice({
  path,
  kind,
  current,
  target,
  onChoose,
}: {
  readonly path: string
  readonly kind: VideoClip["kind"] | undefined
  readonly current: boolean
  readonly target: MediaTarget
  readonly onChoose: () => void
}) {
  const messages = useArtifactMessages().videoEditor
  const parts = useMediaParts(kind === "video" ? target : null, path)
  const stored = target.files.find((file) => file.path === path)
  const picture =
    kind === "image" && stored
      ? artifactFileSource({
          artifactId: target.artifactId,
          version: target.version,
          path,
          fileRef: stored.file,
        }).inlineUrl
      : undefined
  const name = path.replace(/^.*\//, "")

  return (
    <button
      type="button"
      disabled={current}
      aria-label={current ? messages.playingNow(name) : name}
      onClick={onChoose}
      className={cn(
        "group flex w-full flex-col gap-1 rounded-lg p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        current ? "cursor-default" : "hover:bg-muted"
      )}
    >
      <span className="relative block aspect-video w-full overflow-hidden rounded-md bg-neutral-900 text-white/70">
        {parts.filmstrip ? (
          <FilmstripFrame filmstrip={parts.filmstrip} atMs={0} className="absolute inset-0" />
        ) : picture ? (
          <img
            src={picture}
            alt=""
            draggable={false}
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center [&_svg]:size-5">
            {kind === "audio" ? (
              <AudioLines aria-hidden="true" />
            ) : kind === "image" ? (
              <ImageIcon aria-hidden="true" />
            ) : (
              <Video aria-hidden="true" />
            )}
          </span>
        )}
        {current ? (
          <span className="absolute top-1 right-1 flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">
            <Check className="size-3" aria-hidden="true" />
            {messages.inUse}
          </span>
        ) : null}
      </span>
      <span className="truncate px-0.5 text-[12px] text-foreground">{name}</span>
    </button>
  )
}
