import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowDownToLine, Clapperboard, RotateCcw, TriangleAlert } from "lucide-react"
import { useRef } from "react"
import { formatFileSize } from "../../file-size"
import { videoExportUrl } from "../../file-source"
import { FileTypeIcon } from "../../file-type-icon"
import { useArtifactMessages } from "../../messages"
import { formatClock } from "../../playback"
import type { ArtifactVersion } from "../../queries"
import type { VideoExport, VideoExportView } from "./export-state"

// A video's MP4, in its header: once it is rendered, the header's download is the MP4 itself.
// Until then, a menu exports it, shows it rendering part by part on its button, a ring and the
// parts done beside it, and says when it could not, with a retry when one can help; a version not
// exported yet offers the one before it, out of date. A phone's header folds it into More, the
// same entries in it, so the title keeps its room.

/** As the header's other actions: square, quiet, the same icon size. */
const ACTION =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:size-[17px] [&_svg]:stroke-[1.75]"

export function VideoExportMenu({
  version,
  exported,
}: {
  readonly version: ArtifactVersion
  readonly exported: VideoExport
}) {
  const messages = useArtifactMessages().video
  const { view } = exported
  const detail = useReadyDetail(view)
  // Whether the menu was last used with a pointer: closing it then leaves the focus where the
  // pointer is, rather than on the button, which would show its ring and its tooltip.
  const pointer = useRef(false)

  if (view.state === "loading") return null

  // Rendered: Download is the MP4, no menu between.
  if (view.state === "ready") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={videoExportUrl(version)}
            download={messages.mp4(version.title)}
            aria-label={`${messages.downloadMp4}, ${detail}`}
            data-video-export="ready"
            className={ACTION}
          >
            <ArrowDownToLine aria-hidden="true" />
          </a>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {messages.downloadMp4}
          <span className="ml-1.5 text-muted-foreground tabular-nums">{detail}</span>
        </TooltipContent>
      </Tooltip>
    )
  }

  const label =
    view.state === "rendering"
      ? view.assembling
        ? messages.assembling
        : messages.renderingLabel(view.ready, view.total)
      : view.state === "failed"
        ? messages.exportFailed
        : view.state === "unavailable"
          ? messages.exportUnavailable
          : messages.exportMp4

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            aria-label={label}
            data-video-export={view.state}
            className={cn(
              ACTION,
              view.state === "failed" && "text-destructive hover:text-destructive",
              // Wide enough for how far it is, which the reader reads at a glance.
              view.state === "rendering" && "w-auto gap-1.5 px-2"
            )}
          >
            <VideoExportMark view={view} />
            {view.state === "rendering" ? <RenderingCount view={view} /> : null}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-72 p-1.5"
        onPointerDown={() => {
          pointer.current = true
        }}
        onKeyDown={() => {
          pointer.current = false
        }}
        onCloseAutoFocus={(event) => {
          if (pointer.current) event.preventDefault()
        }}
      >
        <VideoExportEntries version={version} exported={exported} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The MP4 as entries of a menu: the header's own until it is rendered, and More's on a phone's
 * header, where it is folded with the rest. `keepOpen` keeps the menu open on Export, so a menu
 * that shows no progress on its button shows it rendering instead.
 */
export function VideoExportEntries({
  version,
  exported,
  keepOpen = false,
}: {
  readonly version: ArtifactVersion
  readonly exported: VideoExport
  readonly keepOpen?: boolean
}) {
  const messages = useArtifactMessages().video
  const { view, start } = exported
  const name = messages.mp4(version.title)
  const readyDetail = useReadyDetail(view)

  if (view.state === "loading") return null

  if (view.state === "ready") {
    return (
      <DropdownMenuItem asChild className="gap-3 rounded-md px-2 py-1.5">
        <a href={videoExportUrl(version)} download={name}>
          <FileTypeIcon type="video" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium text-foreground">
              {messages.downloadMp4}
            </span>
            <span className="truncate text-xs text-muted-foreground tabular-nums">
              {readyDetail}
            </span>
          </span>
        </a>
      </DropdownMenuItem>
    )
  }

  return (
    <>
      <div className="flex items-center gap-3 px-2 pt-1.5 pb-2">
        <FileTypeIcon type="video" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
          <StatusLine view={view} />
        </span>
      </div>

      {view.state === "rendering" ? (
        <div className="px-2 pb-2">
          <ProgressBar view={view} />
          <p className="mt-2 text-xs text-muted-foreground">{messages.renderingHint}</p>
        </div>
      ) : null}

      {view.state === "idle" || view.state === "failed" ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-3 rounded-md px-2 py-1.5"
            onSelect={(event) => {
              if (keepOpen) event.preventDefault()
              void start().catch(() => {})
            }}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-foreground [&_svg]:size-4">
              {view.state === "failed" ? (
                <RotateCcw aria-hidden="true" />
              ) : (
                <Clapperboard aria-hidden="true" />
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">
                {view.state === "failed" ? messages.tryAgain : messages.exportMp4}
              </span>
              {/* A sentence: it wraps rather than lose its end. */}
              <span className="text-xs leading-snug text-muted-foreground">
                {messages.exportMp4Detail}
              </span>
            </span>
          </DropdownMenuItem>
        </>
      ) : null}

      {view.state === "idle" && view.earlier !== undefined ? (
        <DropdownMenuItem asChild className="gap-3 rounded-md px-2 py-1.5">
          <a
            href={videoExportUrl({ artifactId: version.artifactId, version: view.earlier })}
            download={name}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground [&_svg]:size-4">
              <ArrowDownToLine aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">
                {messages.earlierVersion(view.earlier)}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {messages.earlierDetail}
              </span>
            </span>
          </a>
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

/** A rendered MP4's length and size, as its download says them. */
function useReadyDetail(view: VideoExportView): string | undefined {
  const messages = useArtifactMessages()
  const locale = useLocale()
  if (view.state !== "ready") return undefined
  return messages.video.downloadMp4Detail(
    formatClock(view.durationMs / 1000),
    formatFileSize(view.sizeBytes, locale, messages.files)
  )
}

/**
 * The button's mark: the download arrow, how far it has rendered, or that it failed. A project
 * that cannot render keeps the arrow: nothing is wrong with the video.
 */
export function VideoExportMark({ view }: { readonly view: VideoExportView }) {
  if (view.state === "failed") return <TriangleAlert aria-hidden="true" />
  if (view.state !== "rendering") return <ArrowDownToLine aria-hidden="true" />
  return <ProgressRing fraction={view.assembling ? null : view.ready / Math.max(1, view.total)} />
}

/**
 * How far it has rendered, beside the ring: the parts done, `4/13`, after *Rendering* in a header
 * with room for it; while the parts are put together, that it is finishing. The button's label
 * says it in full.
 */
function RenderingCount({
  view,
}: {
  readonly view: Extract<VideoExportView, { state: "rendering" }>
}) {
  const messages = useArtifactMessages().video
  return (
    <span aria-hidden="true" className="text-xs font-medium whitespace-nowrap tabular-nums">
      {view.assembling ? (
        messages.assemblingShort
      ) : (
        <>
          <span className="hidden @lg:inline">{messages.renderingWord} </span>
          {messages.renderingCount(view.ready, view.total)}
        </>
      )}
    </span>
  )
}

/**
 * A ring that fills as parts render; turning, a quarter of it drawn, while they are put together,
 * which has no parts to count.
 */
function ProgressRing({ fraction }: { readonly fraction: number | null }) {
  const radius = 7
  const length = 2 * Math.PI * radius
  const shown = fraction === null ? 0.25 : Math.max(0.06, fraction)
  return (
    <svg
      viewBox="0 0 18 18"
      aria-hidden="true"
      className={cn(
        "-rotate-90",
        fraction === null && "animate-spin [animation-duration:1.4s] motion-reduce:animate-none"
      )}
    >
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${shown * length} ${length}`}
        className="transition-[stroke-dasharray] duration-500 ease-out"
      />
    </svg>
  )
}

function ProgressBar({
  view,
}: {
  readonly view: Extract<VideoExportView, { state: "rendering" }>
}) {
  const fraction = view.assembling ? 1 : view.ready / Math.max(1, view.total)
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={view.total}
      aria-valuenow={view.ready}
      className="h-1.5 overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-500 ease-out",
          view.assembling && "animate-pulse motion-reduce:animate-none"
        )}
        style={{ width: `${Math.max(4, fraction * 100)}%` }}
      />
    </div>
  )
}

function StatusLine({ view }: { readonly view: VideoExportView }) {
  const messages = useArtifactMessages().video
  const text =
    view.state === "rendering"
      ? view.assembling
        ? messages.assembling
        : messages.rendering(view.ready, view.total)
      : view.state === "failed"
        ? messages.exportFailedDetail
        : view.state === "unavailable"
          ? messages.exportUnavailableDetail
          : messages.notExported
  // Why it failed, or that it cannot render, is a sentence: it wraps, where a status stays on one
  // line.
  const sentence = view.state === "failed" || view.state === "unavailable"
  return (
    <span
      role="status"
      title={text}
      className={cn(
        "text-xs tabular-nums",
        sentence ? "leading-snug" : "truncate",
        view.state === "failed" ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {text}
    </span>
  )
}
