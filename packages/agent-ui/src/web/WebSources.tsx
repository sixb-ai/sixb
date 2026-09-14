import { Popover, PopoverContent, PopoverTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowUpRight, Globe, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import type { WebSource } from "./interpret"

const CHIP_CLASS_NAME =
  "inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border border-transparent bg-muted/60 py-1 pr-2.5 pl-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-border data-[state=open]:text-foreground pointer-coarse:min-h-11 motion-reduce:transition-none"

/** Sources stay outside the work disclosure and never become inferred citations in the answer. */
export function WebSources({ sources }: { sources: readonly WebSource[] }) {
  const [expanded, setExpanded] = useState(false)
  const [openSourceId, setOpenSourceId] = useState<string | null>(null)
  const firstExtra = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (expanded) firstExtra.current?.focus()
  }, [expanded])

  const domains = new Map<string, number>()
  for (const source of sources) domains.set(source.domain, (domains.get(source.domain) ?? 0) + 1)

  if (sources.length === 0) return null
  return (
    <div
      className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5"
      role="group"
      aria-label="Web search sources"
    >
      <span className="sr-only" role="status">
        {sources.length} {sources.length === 1 ? "source" : "sources"} found
      </span>
      {sources.slice(0, expanded ? undefined : 3).map((source, index) => {
        const titleId = `${id}-${index}`
        return (
          <Popover
            key={source.id}
            open={openSourceId === source.id}
            onOpenChange={(open) =>
              setOpenSourceId((current) =>
                open ? source.id : current === source.id ? null : current
              )
            }
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                ref={index === 3 ? firstExtra : undefined}
                className={CHIP_CLASS_NAME}
                aria-label={`View source: ${source.title} (${source.domain})`}
              >
                <SourceFavicon url={source.faviconUrl} />
                <span className="min-w-0 truncate">
                  {source.domain}
                  {(domains.get(source.domain) ?? 0) > 1 ? ` · ${source.title}` : ""}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={8}
              collisionPadding={16}
              aria-labelledby={titleId}
              className="sixb-web-source-popover scrollbar-thin w-[340px] max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain rounded-xl p-4"
            >
              <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <SourceFavicon url={source.faviconUrl} />
                <span className="min-w-0 flex-1 truncate">{source.domain}</span>
                <button
                  type="button"
                  aria-label="Close source preview"
                  onClick={() => setOpenSourceId(null)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </div>
              <h3
                id={titleId}
                className="mt-3 line-clamp-4 text-sm leading-snug font-medium break-words"
              >
                {source.title}
              </h3>
              {source.author || source.publishedDate ? (
                <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground break-words">
                  {[source.author, source.publishedDate].filter(Boolean).join(" · ")}
                </p>
              ) : null}
              {source.excerpt ? (
                <p className="mt-3 line-clamp-5 text-[13px] leading-relaxed text-muted-foreground break-words">
                  {source.excerpt}
                </p>
              ) : null}
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 flex min-h-9 items-center justify-between gap-2 border-t pt-3 text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
              >
                Open source<span className="sr-only"> (opens in a new tab)</span>
                <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
              </a>
            </PopoverContent>
          </Popover>
        )
      })}
      {!expanded && sources.length > 3 ? (
        <button
          type="button"
          className={cn(CHIP_CLASS_NAME, "px-2.5")}
          aria-label={`Show ${sources.length - 3} more ${sources.length === 4 ? "source" : "sources"}`}
          onClick={() => setExpanded(true)}
        >
          +{sources.length - 3} {sources.length === 4 ? "source" : "sources"}
        </button>
      ) : null}
    </div>
  )
}

function SourceFavicon({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <span
      className="relative flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded-sm"
      aria-hidden="true"
    >
      {!loaded ? <Globe className="size-3.5" /> : null}
      {!failed ? (
        <img
          src={url}
          alt=""
          width={18}
          height={18}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setFailed(true)
            setLoaded(false)
          }}
          className={cn("absolute inset-0 size-full object-contain", !loaded && "opacity-0")}
        />
      ) : null}
    </span>
  )
}
