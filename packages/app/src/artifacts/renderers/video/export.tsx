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
import { formatFileSize } from "../../file-size"
import { videoExportUrl } from "../../file-source"
import { FileTypeIcon } from "../../file-type-icon"
import { useArtifactMessages } from "../../messages"
import { formatClock } from "../../playback"
import type { ArtifactVersion } from "../../queries"
import { useVideoExport, type VideoExportView } from "./export-state"

// A video's MP4, in its header: once it is rendered, the header's download is the MP4 itself.
// Until then, a menu exports it, shows it rendering part by part on its button, and says why when
// it could not, with a retry; a version not exported yet offers the one before it, out of date.

/** As the header's other actions: square, quiet, the same icon size. */
const ACTION =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:size-[17px] [&_svg]:stroke-[1.75]"

export function VideoExportMenu({ version }: { readonly version: ArtifactVersion }) {
  const messages = useArtifactMessages().video
  const locale = useLocale()
  const files = useArtifactMessages().files
  const { view, start } = useVideoExport(version)
  const name = messages.mp4(version.title)

  if (view.state === "loading") return null

  // Rendered: Download is the MP4, no menu between.
  if (view.state === "ready") {
    const detail = messages.downloadMp4Detail(
      formatClock(view.durationMs / 1000),
      formatFileSize(view.sizeBytes, locale, files)
    )
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={videoExportUrl(version)}
            download={name}
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
        : messages.exportMp4

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={label}
        title={label}
        data-video-export={view.state}
        className={cn(ACTION, view.state === "failed" && "text-destructive hover:text-destructive")}
      >
        <ExportMark view={view} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-72 p-1.5">
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
              onSelect={() => void start().catch(() => {})}
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
                <span className="truncate text-xs text-muted-foreground">
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The button's mark: the download arrow, how far it has rendered, or that it failed. */
function ExportMark({ view }: { readonly view: VideoExportView }) {
  if (view.state === "failed") return <TriangleAlert aria-hidden="true" />
  if (view.state !== "rendering") return <ArrowDownToLine aria-hidden="true" />
  return <ProgressRing fraction={view.assembling ? null : view.ready / Math.max(1, view.total)} />
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
        ? view.reason
        : messages.notExported
  return (
    <span
      role="status"
      title={text}
      className={cn(
        "text-xs tabular-nums",
        // Why it failed is a sentence: it wraps, where a status stays on one line.
        view.state === "failed" ? "line-clamp-3 text-destructive" : "truncate text-muted-foreground"
      )}
    >
      {text}
    </span>
  )
}
