import { isSixbApiError, type ListArtifactsResponse } from "@sixb/client"
import { getArtifactVersionOptions, listArtifactsInfiniteOptions } from "@sixb/client/hooks"
import { ARTIFACT_KINDS, type ArtifactKind } from "@sixb/core/artifacts"
import { ToggleGroup, ToggleGroupItem } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Layers } from "lucide-react"
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Link, useSearchParams } from "react-router-dom"
import { artifactHref } from "../pages/routes"
import { useFormat } from "../pages/section-ui"
import { versionSummary } from "./card-details"
import { ArtifactLabel, ArtifactPreview, SlideFace } from "./card-preview"
import { ArtifactFrame } from "./frame"
import { ArtifactKindIcon } from "./kind-icon"
import { useArtifactMessages } from "./messages"
import { type ArtifactVersion, useArtifactTheme } from "./queries"
import { PageScreen } from "./renderers/page"
import { artifactThemeAttributes } from "./theme"

type ArtifactSummary = ListArtifactsResponse["artifacts"][number]

const PAGE_SIZE = 24
/** The filter's value for every kind; a kind's value is its name. */
const ALL = "all"

/**
 * Every artifact the reader can open, most recently updated first, as cards with a preview of
 * each, filtered by kind (`?kind=sheet`). More load as the reader scrolls to the end.
 */
export function ArtifactsPage() {
  const { gallery: messages, viewer } = useArtifactMessages()
  const [params, setParams] = useSearchParams()
  const kind = ARTIFACT_KINDS.find((candidate) => candidate === params.get("kind"))
  const list = useInfiniteQuery({
    ...listArtifactsInfiniteOptions({
      query: { limit: String(PAGE_SIZE), ...(kind ? { kind } : {}) },
    }),
    // The next page's offset, as the query carries it.
    initialPageParam: "0",
    getNextPageParam: (last: ListArtifactsResponse, pages: readonly ListArtifactsResponse[]) =>
      last.hasMore ? String(pages.length * PAGE_SIZE) : undefined,
  })
  // Pages are offsets into a list that changes while the reader scrolls: an artifact updated in
  // the meantime moves up, and can be on two pages at once. It shows once, where it came first.
  const artifacts = useMemo(() => {
    const byId = new Map<string, ArtifactSummary>()
    for (const artifact of list.data?.pages.flatMap((page) => page.artifacts) ?? []) {
      if (!byId.has(artifact.id)) byId.set(artifact.id, artifact)
    }
    return [...byId.values()]
  }, [list.data])
  const total = list.data?.pages[0]?.total

  const choose = (next: ArtifactKind | undefined) => {
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
        isSixbApiError(list.error) && list.error.status === 501 ? (
          // Trying again cannot help until the server is given artifact storage.
          <Message title={messages.loadFailed} description={viewer.storageUnavailable} />
        ) : (
          <Message
            title={messages.loadFailed}
            action={messages.retry}
            onAction={() => list.refetch()}
          />
        )
      ) : list.isPending ? (
        <Grid>
          {Array.from({ length: 8 }, (_, index) => (
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
              ? Array.from({ length: 4 }, (_, index) => <CardSkeleton key={`more-${index}`} />)
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

/** One choice of kind, or all of them: a single tab stop, stepped through with the arrow keys. */
function KindFilter({
  kind,
  onChange,
}: {
  readonly kind: ArtifactKind | undefined
  readonly onChange: (kind: ArtifactKind | undefined) => void
}) {
  const messages = useArtifactMessages().gallery
  const value = kind ?? ALL
  const options: readonly { value: ArtifactKind | typeof ALL; label: string }[] = [
    { value: ALL, label: messages.all },
    ...ARTIFACT_KINDS.map((option) => ({ value: option, label: messages.kinds[option] })),
  ]
  return (
    <div className="-mx-4 flex max-w-[calc(100%+2rem)] overflow-x-auto px-4 sm:mx-0 sm:max-w-full sm:px-0">
      <ToggleGroup
        type="single"
        value={value}
        // Choosing the chosen kind again would clear the group; the filter always has a choice.
        onValueChange={(next) => {
          if (next) onChange(ARTIFACT_KINDS.find((option) => option === next))
        }}
        aria-label={messages.filter}
        spacing={0.5}
        className="shrink-0 rounded-full border border-border/70 bg-muted/50 p-1"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className={cn(
              "h-8 gap-1.5 rounded-full px-3.5 text-[13px] font-normal text-muted-foreground transition-[background-color,color,box-shadow] hover:bg-transparent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-background data-[state=on]:font-medium data-[state=on]:text-foreground",
              option.value === value && "shadow-[0_1px_2px_rgb(0_0_0/0.08)] ring-1 ring-border/60"
            )}
          >
            {option.value === ALL ? (
              <Layers className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <ArtifactKindIcon kind={option.value} className="size-3.5 shrink-0" />
            )}
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
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
  const format = useFormat()
  const pane = useRef<HTMLDivElement | null>(null)
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined")
  useNearScreen(pane, "400px 0px", () => setSeen(true), !seen)
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
        ) : artifact.kind === "page" && version.data ? (
          <PageScreen version={version.data} />
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
      <ArtifactLabel
        title={artifact.title}
        detail={
          version.data
            ? versionSummary(version.data, messages, locale)
            : messages.kinds[artifact.kind]
        }
        after={
          <>
            <span aria-hidden="true">·</span>
            <time
              dateTime={artifact.updatedAt}
              className="shrink-0"
              title={format.dateTime(artifact.updatedAt)}
            >
              {format.relative(artifact.updatedAt)}
            </time>
            {artifact.latestVersion > 1 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">{messages.viewer.version(artifact.latestVersion)}</span>
              </>
            ) : null}
          </>
        }
        icon={
          <ArtifactKindIcon
            kind={artifact.kind}
            className="mt-[3px] size-4 shrink-0 text-muted-foreground"
          />
        }
        large
        className="items-start px-1 pt-3"
      />
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
 * on, in the deck's own theme. It fades in over the slide's title, which stays if it never loads.
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
          fallback={<SlideFace version={version} />}
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
  useNearScreen(sentinel, "600px 0px", onVisible, !busy)
  return <div ref={sentinel} className="h-px" aria-hidden="true" />
}

/**
 * Calls `onNear` each time an element comes within `margin` of the screen, while `active`. Where
 * the browser cannot tell, it never calls it.
 */
function useNearScreen(
  element: RefObject<Element | null>,
  margin: string,
  onNear: () => void,
  active: boolean
): void {
  const callback = useRef(onNear)
  callback.current = onNear
  useEffect(() => {
    const target = element.current
    if (!active || !target || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current()
      },
      { rootMargin: margin }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [element, margin, active])
}
