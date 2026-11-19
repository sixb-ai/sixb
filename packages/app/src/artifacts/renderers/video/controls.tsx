import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Slider,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  Link2,
  ListVideo,
  Maximize,
  MessageSquare,
  MessageSquarePlus,
  Minimize,
  Pause,
  Play,
  Settings2,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react"
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react"
import { useArtifactMessages } from "../../messages"
import { formatClock } from "../../playback"
import type { Playback } from "./playback"

// The bar along the foot of the video: play, sound and the time on its left, then the chapter
// playing, and on its right commenting, the panels, the settings and fullscreen. White on the
// video's own shade, whatever the app's theme, as players draw theirs.

/** The speeds a video plays at. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export function ControlBar({
  playback,
  chapter,
  scrubber,
  compact,
  comments,
  chaptersOpen,
  onChapters,
  fullscreen,
  onFullscreen,
  onCopyLink,
  menuContainer,
}: {
  readonly playback: Playback
  /** The chapter playing, when the video has more than one. */
  readonly chapter: string | undefined
  readonly scrubber: ReactNode
  /** A narrow player, as on a phone: the panels and commenting move under the video. */
  readonly compact: boolean
  /** Commenting, where the reader may comment. */
  readonly comments: {
    readonly open: number
    readonly placing: boolean
    readonly panel: boolean
    readonly onPlace: () => void
    /** Opens the comments beside the video; none while it fills the screen. */
    readonly onPanel: (() => void) | null
  } | null
  readonly chaptersOpen: boolean
  /** Opens the chapters; none for a video of one scene, or while it fills the screen. */
  readonly onChapters: (() => void) | null
  readonly fullscreen: boolean
  readonly onFullscreen: () => void
  /** Copies a link to the instant shown; none where the reader has no link to share. */
  readonly onCopyLink: (() => void) | null
  /** Where its menu goes: the element shown fullscreen, while it is. */
  readonly menuContainer: HTMLElement | null
}) {
  const messages = useArtifactMessages().video
  const { playing, muted, volume } = playback
  const silent = muted || volume === 0
  // Inline on a phone, the bar keeps to the picture's foot: smaller buttons, closer together.
  const tight = compact && !fullscreen

  return (
    <div
      className={cn(
        tight ? "flex flex-col gap-0.5 px-2 pb-1" : "flex flex-col gap-1 px-3 pb-2 sm:px-4 sm:pb-3",
        // Filling a phone, the bar stays clear of its home indicator and, sideways, its notch.
        fullscreen &&
          "pr-[max(0.75rem,env(safe-area-inset-right))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))]"
      )}
    >
      {scrubber}

      <div
        className={cn(
          "flex items-center gap-0.5 text-white",
          tight && "[&_button]:size-9 [@media(pointer:coarse)]:[&_button]:size-10"
        )}
      >
        <BarButton
          label={playing ? messages.pause : messages.play}
          keys="K"
          onClick={playback.toggle}
          data-video-play=""
        >
          {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
        </BarButton>

        <div className="group/volume flex items-center">
          <BarButton
            label={silent ? messages.unmute : messages.mute}
            keys="M"
            onClick={() => playback.setMuted(!silent)}
          >
            {silent ? <VolumeX /> : volume < 0.5 ? <Volume1 /> : <Volume2 />}
          </BarButton>
          {/* Phones set the volume with their buttons: a page cannot. */}
          <div className="w-0 overflow-hidden opacity-0 transition-[width,opacity] duration-200 group-focus-within/volume:w-20 group-focus-within/volume:opacity-100 group-hover/volume:w-20 group-hover/volume:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:hidden">
            <Slider
              value={[silent ? 0 : volume]}
              max={1}
              step={0.05}
              aria-label={messages.volume}
              onValueChange={([value]) => {
                if (value !== undefined) playback.setVolume(value)
              }}
              className="mx-2 w-16 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-track]]:bg-white/30"
            />
          </div>
        </div>

        <span className="ml-1.5 shrink-0 text-[12.5px] font-medium text-white tabular-nums [text-shadow:0_1px_2px_rgb(0_0_0/0.5)]">
          {formatClock(playback.time)}
          <span className="text-white/70"> / {formatClock(playback.duration)}</span>
        </span>

        {chapter ? (
          <span className="ml-3 hidden min-w-0 truncate text-[12.5px] text-white/85 [text-shadow:0_1px_2px_rgb(0_0_0/0.5)] @lg:block">
            <span aria-hidden="true" className="mr-2 text-white/35">
              ·
            </span>
            {chapter}
          </span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {comments && !compact ? (
            <>
              <BarButton
                label={messages.comment}
                keys="C"
                pressed={comments.placing}
                onClick={comments.onPlace}
                data-video-comment=""
              >
                <MessageSquarePlus />
              </BarButton>
              {comments.onPanel ? (
                <BarButton
                  label={messages.commentsPanel(comments.open)}
                  pressed={comments.panel}
                  onClick={comments.onPanel}
                  className="w-auto gap-1 px-2"
                >
                  <MessageSquare />
                  {comments.open > 0 ? (
                    <span className="text-xs font-medium tabular-nums">{comments.open}</span>
                  ) : null}
                </BarButton>
              ) : null}
            </>
          ) : null}
          {onChapters && !compact ? (
            <BarButton label={messages.chapters} pressed={chaptersOpen} onClick={onChapters}>
              <ListVideo />
            </BarButton>
          ) : null}

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <BarButton label={messages.settings}>
                <Settings2 />
              </BarButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={8}
              container={menuContainer}
              className="min-w-52"
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {messages.speed}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={String(playback.rate)}
                onValueChange={(value) => playback.setRate(Number(value))}
              >
                {PLAYBACK_RATES.map((rate) => (
                  <DropdownMenuRadioItem key={rate} value={String(rate)}>
                    {rate === 1 ? messages.normalSpeed : messages.rate(rate)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {onCopyLink ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onCopyLink}>
                    <Link2 aria-hidden="true" />
                    {messages.copyLink(formatClock(playback.time))}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <BarButton
            label={fullscreen ? messages.exitFullscreen : messages.fullscreen}
            keys="F"
            onClick={onFullscreen}
          >
            {fullscreen ? <Minimize /> : <Maximize />}
          </BarButton>
        </div>
      </div>
    </div>
  )
}

/**
 * A round, quiet button on the bar, its name and key in its tooltip; larger under a finger. A menu's
 * trigger takes it as its own.
 */
const BarButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & {
    readonly label: string
    readonly keys?: string
    readonly pressed?: boolean
  }
>(function BarButton({ label, keys, pressed, className, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={keys}
      title={keys ? `${label} (${keys})` : label}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full text-white/90 outline-none transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/80 data-[state=open]:bg-white/15 [&_svg]:size-[18px] [@media(pointer:coarse)]:size-11",
        pressed && "bg-white/20 text-white",
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
})
