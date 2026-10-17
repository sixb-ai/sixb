import type { ListArtifactsResponse } from "@sixb/client"
import { getArtifactVersionOptions, listArtifactsInfiniteOptions } from "@sixb/client/hooks"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Layers } from "lucide-react"
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { artifactHref } from "../pages/routes"
import { versionSummary } from "./card-details"
import { ArtifactPreview } from "./card-preview"
import { ArtifactFrame } from "./frame"
import { ArtifactKindIcon, type ArtifactKindName } from "./kind-icon"
import { useArtifactMessages } from "./messages"
import { type ArtifactVersion, useArtifactTheme } from "./queries"
import { artifactThemeAttributes } from "./theme"

type ArtifactSummary = ListArtifactsResponse["artifacts"][number]

/** The kinds the gallery filters by, in the order the Agent's skill presents them. */
const GALLERY_KINDS = [
  "document",
  "sheet",
  "slides",
  "file",
] as const satisfies readonly ArtifactKindName[]
type GalleryKind = (typeof GALLERY_KINDS)[number]
const PAGE_SIZE = 24

/**
 * Every artifact the reader can open, most recently updated first, as cards with a preview of
 * each, filtered by kind (`?kind=sheet`). More load as the reader scrolls to the end.
 */
export function ArtifactsPage() {
  const messages = useArtifactMessages().gallery
  const [params, setParams] = useSearchParams()
  const kind = GALLERY_KINDS.find((candidate) => candidate === params.get("kind"))
  const list = useInfiniteQuery({
    ...listArtifactsInfiniteOptions({
      query: { limit: String(PAGE_SIZE), ...(kind ? { kind } : {}) },
    }),
    // The next page's offset, as the query carries it.
    initialPageParam: "0",
    getNextPageParam: (last: ListArtifactsResponse, pages: readonly ListArtifactsResponse[]) =>
      last.hasMore ? String(pages.length * PAGE_SIZE) : undefined,
  })
  const artifacts = list.data?.pages.flatMap((page) => page.artifacts) ?? []
  const total = list.data?.pages[0]?.total

  const choose = (next: GalleryKind | undefined) => {
    const updated = new URLSearchParams(params)
    if (next) updated.set("kind", next)
    else updated.delete("kind")
    setParams(updated, { replace: true })
  }

  return (
    <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-8 px-4 pt-8 pb-16 sm:px-6 sm:pt-12 lg:px-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em] sm:text-[32px]">
          {messages.title}
        </h1>
        <p className="max-w-[60ch] text-[14.5px] text-muted-foreground">{messages.description}</p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <KindFilter kind={kind} onChange={choose} />
        <span className="text-[13px] text-muted-foreground tabular-nums" aria-live="polite">
          {total === undefined ? null : messages.count(total, kind)}
        </span>
      </div>

      {list.isError ? (
        <Message
          title={messages.loadFailed}
          action={messages.retry}
          onAction={() => list.refetch()}
        />
      ) : list.isPending ? (
        <Grid>
          {Array.from({ length: 8 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have nothing else to key by
            <CardSkeleton key={index} />
          ))}
        </Grid>
      ) : artifacts.length === 0 ? (
        kind ? (
          <Message
            title={messages.emptyKind(kind)}
            action={messages.showAll}
            onAction={() => choose(undefined)}
          />
        ) : (
          <Message title={messages.empty} description={messages.emptyDescription} />
        )
      ) : (
        <>
          <Grid>
            {artifacts.map((artifact) => (
              <GalleryCard key={artifact.id} artifact={artifact} />
            ))}
            {list.isFetchingNextPage
              ? Array.from({ length: 4 }, (_, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have nothing else to key by
                  <CardSkeleton key={`more-${index}`} />
                ))
              : null}
          </Grid>
          {list.hasNextPage ? (
            <LoadMore onVisible={() => list.fetchNextPage()} busy={list.isFetchingNextPage} />
          ) : null}
        </>
      )}
    </div>
  )
}

function KindFilter({
  kind,
  onChange,
}: {
  readonly kind: GalleryKind | undefined
  readonly onChange: (kind: GalleryKind | undefined) => void
}) {
  const messages = useArtifactMessages().gallery
  const options: readonly { value: GalleryKind | undefined; label: string }[] = [
    { value: undefined, label: messages.all },
    ...GALLERY_KINDS.map((value) => ({ value, label: messages.kinds[value] })),
  ]
  return (
    <div
      role="radiogroup"
      aria-label={messages.filter}
      className="-mx-4 flex max-w-[calc(100%+2rem)] overflow-x-auto px-4 sm:mx-0 sm:max-w-full sm:px-0"
    >
      <div className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-muted/50 p-1">
        {options.map((option) => {
          const selected = option.value === kind
          return (
            <button
              key={option.value ?? "all"}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] whitespace-nowrap outline-none transition-[background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)] ring-1 ring-border/60"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.value ? (
                <ArtifactKindIcon kind={option.value} className="size-3.5 shrink-0" />
              ) : (
                <Layers className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Grid({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {children}
    </div>
  )
}

/** An artifact as a card that opens it: a large preview of its latest version, then its name. */
function GalleryCard({ artifact }: { readonly artifact: ArtifactSummary }) {
  const locale = useLocale()
  const messages = useArtifactMessages()
  const pane = useRef<HTMLDivElement | null>(null)
  const seen = useSeen(pane)
  const version = useQuery({
    ...getArtifactVersionOptions({
      path: { artifactId: artifact.id, version: String(artifact.latestVersion) },
    }),
    // A version never changes once published; the card reads it when it nears the screen.
    enabled: seen,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  return (
    <Link
      to={artifactHref(artifact.id)}
      className="group flex flex-col rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
    >
      <div
        ref={pane}
        className="relative aspect-[16/10] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow,transform] duration-200 ease-out group-hover:-translate-y-0.5 group-hover:border-foreground/15 group-hover:shadow-[0_12px_32px_-14px_rgb(0_0_0/0.22)] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
      >
        {artifact.kind === "slides" && version.data ? (
          <FirstSlide version={version.data} />
        ) : (
          <ScaledPreview>
            <ArtifactPreview
              kind={artifact.kind}
              version={version.data}
              loading={version.isLoading}
            />
          </ScaledPreview>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-2.5 px-1 pt-3">
        <ArtifactKindIcon
          kind={artifact.kind}
          className="mt-[3px] size-4 shrink-0 text-muted-foreground"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className="truncate text-[14px] leading-snug font-medium text-foreground"
            title={artifact.title}
          >
            {artifact.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-snug text-muted-foreground tabular-nums">
            <span className="truncate">
              {version.data
                ? versionSummary(version.data, messages, locale)
                : messages.kinds[artifact.kind]}
            </span>
            <span aria-hidden="true">·</span>
            <time dateTime={artifact.updatedAt} className="shrink-0" title={artifact.updatedAt}>
              {relativeTime(artifact.updatedAt, locale)}
            </time>
            {artifact.latestVersion > 1 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">{messages.viewer.version(artifact.latestVersion)}</span>
              </>
            ) : null}
          </span>
        </div>
      </div>
    </Link>
  )
}

/**
 * The width a preview is laid out at before it is scaled to the card: a little wider than a
 * conversation's card, so a gallery card shows a little more of the artifact at a calmer size.
 */
const PREVIEW_WIDTH = 300

/**
 * A preview laid out at a card's width, then scaled to fill the pane, so the gallery shows the
 * face a conversation's card shows, larger, rather than the same type lost in more space.
 */
function ScaledPreview({ children }: { readonly children: ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setScale(Math.max(element.clientWidth, 1) / PREVIEW_WIDTH)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={box} aria-hidden="true" className="absolute inset-0">
      <div
        className="relative origin-top-left"
        style={{ width: PREVIEW_WIDTH, height: `${100 / scale}%`, transform: `scale(${scale})` }}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * A deck's real first slide, live in a frame that fills it, on the ground a deck's card sets it
 * on, in the deck's own theme. It fades in over a blank slide once its theme applies.
 */
function FirstSlide({ version }: { readonly version: ArtifactVersion }) {
  const theme = artifactThemeAttributes(useArtifactTheme(version))
  return (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center bg-muted/70 px-[7%]",
        theme.className
      )}
      style={theme.style}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-[5px] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.08),0_6px_18px_rgb(0_0_0/0.08)] ring-1 ring-black/[0.05] dark:ring-white/10">
        <ArtifactFrame
          version={version}
          title={version.title}
          start={{ slide: 1, fill: true }}
          decorative
          className="absolute inset-0"
        />
      </div>
    </div>
  )
}

function CardSkeleton() {
  return (
    <div className="flex flex-col" aria-hidden="true">
      <div className="aspect-[16/10] animate-pulse rounded-2xl border border-border/50 bg-muted/60" />
      <div className="flex items-center gap-2.5 px-1 pt-3">
        <div className="size-4 rounded bg-muted" />
        <div className="h-3.5 w-2/3 rounded bg-muted" />
      </div>
      <div className="ml-[26px] mt-2 h-3 w-1/3 rounded bg-muted/70" />
    </div>
  )
}

function Message({
  title,
  description,
  action,
  onAction,
}: {
  readonly title: string
  readonly description?: string
  readonly action?: string
  readonly onAction?: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-20 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Layers className="size-5" aria-hidden="true" />
      </span>
      <p className="text-[15px] font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-[46ch] text-[13.5px] text-muted-foreground">{description}</p>
      ) : null}
      {action && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-1 rounded-full border border-border px-4 py-1.5 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action}
        </button>
      ) : null}
    </div>
  )
}

/** Asks for the next page when the end of the grid nears the screen. */
function LoadMore({ onVisible, busy }: { readonly onVisible: () => void; readonly busy: boolean }) {
  const sentinel = useRef<HTMLDivElement | null>(null)
  const callback = useRef(onVisible)
  callback.current = onVisible
  useEffect(() => {
    const element = sentinel.current
    if (!element || busy || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current()
      },
      { rootMargin: "600px 0px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [busy])
  return <div ref={sentinel} className="h-px" aria-hidden="true" />
}

/** Whether an element has come within a screen of view; once it has, it stays seen. */
function useSeen(element: { readonly current: Element | null }): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined")
  useEffect(() => {
    const target = element.current
    if (seen || !target) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
      },
      { rootMargin: "400px 0px" }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [element, seen])
  return seen
}

/** "3 hours ago", "yesterday", or a date past a week, in the reader's language. */
function relativeTime(iso: string, locale: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const seconds = Math.round((then - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const abs = Math.abs(seconds)
  if (abs < 60) return format.format(0, "second")
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute")
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour")
  if (abs < 7 * 86_400) return format.format(Math.round(seconds / 86_400), "day")
  return new Date(then).toLocaleDateString(locale, { month: "short", day: "numeric" })
}
