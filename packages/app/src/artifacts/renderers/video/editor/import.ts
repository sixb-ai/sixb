import { uploadFile } from "@sixb/client"
import { artifactSizeLimits } from "@sixb/core/artifacts"
import { insertClip, type VideoImportKind, type VideoTrack } from "@sixb/core/artifacts/live"
import { useLocale } from "@sixb/ui/lib/i18n"
import { useCallback, useRef, useState } from "react"
import { formatFileSize } from "../../../file-size"
import type { LiveVideo } from "../../../live/video"
import { useArtifactMessages } from "../../../messages"
import { revealDuration } from "../../../playback"

// Files dropped on the tracks become clips where they are dropped, and anywhere else, or added
// with Add media, clips of the open chapter at the playhead, one after the other, each placed as
// any clip is: past its chapter's end, it goes on in the next. Each is uploaded first, staged when
// it is large, and shows where it will land with its progress; once stored it joins the video's
// files and its clip is added, playing at once while Sixb derives its proxy, filmstrip and
// transcript.

/** How long a picture shows once added. */
const PICTURE_MS = 3_000

/** A file on its way, drawn where it will land. */
export interface Upload {
  readonly id: string
  readonly name: string
  readonly track: VideoTrack
  /** From the video's start. */
  readonly startMs: number
  readonly durationMs: number
  /** From 0 to 1. */
  readonly progress: number
}

/** Where dropped files go: a scene's file, from its start in the video. */
export interface ImportTarget {
  readonly file: string
  readonly sceneStartMs: number
  /** From the scene's start. */
  readonly atMs: number
}

export function useMediaImport(
  video: LiveVideo,
  onError: (message: string) => void
): {
  readonly uploads: readonly Upload[]
  readonly importFiles: (files: readonly File[], target: ImportTarget) => Promise<void>
} {
  const messages = useArtifactMessages()
  const locale = useLocale()
  const [uploads, setUploads] = useState<readonly Upload[]>([])
  const counter = useRef(0)

  const importFiles = useCallback(
    async (files: readonly File[], target: ImportTarget) => {
      const { maxFileBytes } = artifactSizeLimits("video")
      let atMs = target.atMs

      for (const file of files) {
        const kind = importKind(file)
        if (!kind) {
          onError(messages.videoEditor.notMedia(file.name))
          continue
        }
        if (file.size > maxFileBytes) {
          onError(
            messages.videoEditor.tooLarge(
              file.name,
              formatFileSize(maxFileBytes, locale, messages.files)
            )
          )
          continue
        }

        const durationMs = kind === "image" ? PICTURE_MS : await mediaLength(file)
        counter.current += 1
        const id = `upload-${counter.current}`
        const shown: Upload = {
          id,
          name: file.name,
          track: kind === "audio" ? "sound" : "picture",
          startMs: target.sceneStartMs + atMs,
          durationMs,
          progress: 0,
        }
        setUploads((current) => [...current, shown])

        try {
          const path = mediaPath(video, file.name)
          const ref = await uploadFile(file, {
            fileName: path.split("/").at(-1) ?? path,
            onProgress: ({ loadedBytes, totalBytes, stage }) => {
              // Hashing a staged file comes first: it is the first tenth.
              const share = totalBytes > 0 ? loadedBytes / totalBytes : 0
              const progress = stage === "hash" ? share * 0.1 : 0.1 + share * 0.9
              setUploads((current) =>
                current.map((each) => (each.id === id ? { ...each, progress } : each))
              )
            },
          })

          video.addFile(path, ref)
          const startMs = atMs
          const refused = video.apply((sources) =>
            insertClip(sources, target.file, { kind, src: path, startMs, durationMs })
          )
          if (refused) onError(refused)
          else atMs += durationMs
        } catch {
          onError(messages.videoEditor.uploadFailed(file.name))
        } finally {
          setUploads((current) => current.filter((each) => each.id !== id))
        }
      }
    },
    [video, onError, messages, locale]
  )

  return { uploads, importFiles }
}

/** What a file is added as, by its type; null for one a video cannot play or show. */
export function importKind(file: Pick<File, "type" | "name">): VideoImportKind | null {
  const type = file.type || typeByName(file.name)
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image"
  return null
}

function typeByName(name: string): string {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ""
  if (["mp4", "mov", "m4v", "webm"].includes(extension)) return "video/*"
  if (["mp3", "m4a", "wav", "aac", "ogg", "oga", "flac"].includes(extension)) return "audio/*"
  if (["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(extension)) return "image/*"
  return ""
}

/** Where an uploaded file goes in the video: `media/<its name>`, made safe, and its own. */
function mediaPath(video: LiveVideo, name: string): string {
  const sources = video.getState().sources
  const dot = name.lastIndexOf(".")
  const stem =
    (dot > 0 ? name.slice(0, dot) : name)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 60) || "media"
  const extension =
    dot > 0
      ? name
          .slice(dot)
          .toLowerCase()
          .replace(/[^.a-z0-9]/g, "")
      : ""

  let path = `media/${stem}${extension}`
  for (let n = 2; sources.has(path); n += 1) path = `media/${stem}-${n}${extension}`
  return path
}

/** How long a recording plays, as the browser reads it; 5 s when it cannot. */
function mediaLength(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const element = document.createElement(file.type.startsWith("audio/") ? "audio" : "video")
    const done = (ms: number) => {
      URL.revokeObjectURL(url)
      element.removeAttribute("src")
      resolve(Math.max(100, Math.round(ms)))
    }
    const timer = setTimeout(() => done(5_000), 5_000)
    element.preload = "metadata"
    element.muted = true
    element.addEventListener("loadedmetadata", () => revealDuration(element))
    element.addEventListener("durationchange", () => {
      if (!Number.isFinite(element.duration)) return
      clearTimeout(timer)
      done(element.duration * 1000)
    })
    element.addEventListener("error", () => {
      clearTimeout(timer)
      done(5_000)
    })
    element.src = url
  })
}
