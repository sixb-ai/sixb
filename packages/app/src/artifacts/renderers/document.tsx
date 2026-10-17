import { Markdown, type MarkdownProps } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import {
  AlertTriangle,
  Info,
  Lightbulb,
  Link2,
  MessageSquareWarning,
  OctagonAlert,
} from "lucide-react"
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { type ArtifactMessages, useArtifactMessages } from "../messages"
import {
  type ArtifactVersion,
  useArtifactTheme,
  useFileText,
  versionFileSource,
  versionImageSource,
} from "../queries"
import { artifactLink } from "../target"
import { artifactThemeAttributes } from "../theme"
import { CALLOUT_KINDS, type CalloutKind, rehypeArtifactDocument } from "./document-tree"
import { ViewerLoading, ViewerNotice } from "./notice"

const DOCUMENT_ENTRY = "document.md"
const REHYPE_PLUGINS: MarkdownProps["rehypePlugins"] = [rehypeArtifactDocument]

/**
 * A document as a page to read: its title and lede, a measured column, figures with captions,
 * callouts, and an outline that follows the reader. It draws only on theme tokens, so the app's
 * theme, dark mode, and the artifact's own `theme.json` all apply.
 */
export function DocumentRenderer({
  version,
  latestVersion,
  part,
}: {
  readonly version: ArtifactVersion
  /** Links to a section of the latest version follow the artifact; others pin this version. */
  readonly latestVersion: number
  /** The section to show first, by its slug. */
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  const locale = useLocale()
  const source = versionFileSource(version, DOCUMENT_ENTRY)
  const file = useFileText(source)
  const theme = artifactThemeAttributes(useArtifactTheme(version))
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const headings = useMemo(
    () =>
      version.outline.kind === "document"
        ? version.outline.headings.filter((heading) => heading.depth === 2 || heading.depth === 3)
        : [],
    [version.outline]
  )
  const activeSlug = useActiveHeading(scrollRef, headings, file.text)

  const scrollToSection = useCallback((slug: string) => {
    const heading = scrollRef.current?.querySelector(`[id="${CSS.escape(slug)}"]`)
    heading?.scrollIntoView({ block: "start", behavior: "smooth" })
  }, [])

  useEffect(() => {
    if (!part || file.text === undefined) return
    scrollRef.current
      ?.querySelector(`[id="${CSS.escape(part)}"]`)
      ?.scrollIntoView({ block: "start" })
  }, [part, file.text])

  const components = useMemo(
    () => documentComponents(version, latestVersion, messages.document, scrollToSection),
    [version, latestVersion, messages.document, scrollToSection]
  )

  if (!source) return <ViewerNotice title={messages.viewer.loadFailed} />
  if (file.loading) return <ViewerLoading label={messages.viewer.loading} />
  if (file.tooLarge || file.error || file.text === undefined) {
    return <ViewerNotice title={file.error ? messages.files[file.error] : messages.files.noText} />
  }

  const published = new Date(version.createdAt).toLocaleDateString(locale, { dateStyle: "long" })
  return (
    <div
      ref={scrollRef}
      data-sixb-artifact=""
      data-sixb-artifact-print=""
      className={cn(
        "@container min-h-0 flex-1 overflow-y-auto bg-background text-foreground",
        theme.className
      )}
      style={theme.style}
    >
      <div className="mx-auto flex w-full max-w-[66rem] gap-14 px-6 py-10 @lg:px-12 @lg:py-14">
        <article className="min-w-0 flex-1">
          {/* The header says which version this is; a printed page says it here. */}
          <p className="sixb-document-meta hidden print:block">
            {messages.document.meta(version.version, published)}
          </p>
          <Markdown
            className="sixb-document"
            components={components}
            rehypePlugins={REHYPE_PLUGINS}
          >
            {file.text}
          </Markdown>
        </article>
        {headings.length > 1 ? (
          <nav
            aria-label={messages.document.outline}
            className="sticky top-14 hidden w-48 shrink-0 self-start print:hidden @4xl:block"
          >
            <p className="mb-3 text-xs font-semibold text-muted-foreground">
              {messages.document.outline}
            </p>
            <ol className="flex flex-col gap-2 text-[13px] leading-snug">
              {headings.map((heading) => (
                <li key={heading.slug} className={heading.depth === 3 ? "pl-3" : undefined}>
                  <a
                    href={`#${heading.slug}`}
                    onClick={(event) => {
                      event.preventDefault()
                      scrollToSection(heading.slug)
                    }}
                    aria-current={activeSlug === heading.slug ? "location" : undefined}
                    className={cn(
                      "block transition-colors hover:text-foreground",
                      activeSlug === heading.slug
                        ? "font-medium text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    {heading.text}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The section the reader is in: the last heading that has scrolled past the reading line. The
 * document scrolls itself when its host gives it a height, and scrolls with the page when the host
 * lets it grow, so this follows whichever element scrolls.
 */
function useActiveHeading(
  scrollRef: { readonly current: HTMLDivElement | null },
  headings: readonly { readonly slug: string }[],
  content: string | undefined
): string | null {
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    const container = scrollRef.current
    if (!container || content === undefined || headings.length === 0) return
    let frame = 0
    const update = () => {
      frame = 0
      const top = Math.max(container.getBoundingClientRect().top, 0) + 96
      let current: string | null = headings[0]?.slug ?? null
      for (const heading of headings) {
        const element = container.querySelector(`[id="${CSS.escape(heading.slug)}"]`)
        if (element && element.getBoundingClientRect().top <= top) current = heading.slug
      }
      setActive(current)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    // Scroll events do not bubble; capturing at the document sees every scrolling element.
    document.addEventListener("scroll", schedule, { capture: true, passive: true })
    return () => {
      document.removeEventListener("scroll", schedule, { capture: true })
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollRef, headings, content])
  return active
}

function documentComponents(
  version: ArtifactVersion,
  latestVersion: number,
  messages: ArtifactMessages["document"],
  scrollToSection: (slug: string) => void
): NonNullable<MarkdownProps["components"]> {
  const heading =
    (Tag: "h2" | "h3") =>
    ({ node: _node, id, children, ...props }: ComponentProps<"h2"> & { node?: unknown }) => (
      <Tag id={id} {...props}>
        {children}
        {id ? (
          <SectionAnchor
            version={version}
            latestVersion={latestVersion}
            slug={id}
            label={messages.copySection(headingText(version, id))}
          />
        ) : null}
      </Tag>
    )

  return {
    h2: heading("h2"),
    h3: heading("h3"),
    img({ node: _node, src, alt, ...props }) {
      const source = typeof src === "string" ? versionImageSource(version, src) : null
      return source ? (
        <img src={source.inlineUrl} alt={alt ?? ""} loading="lazy" {...props} />
      ) : null
    },
    a({ node: _node, href, children, ...props }) {
      if (href?.startsWith("#")) {
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              scrollToSection(decodeURIComponent(href.slice(1)))
            }}
            {...props}
          >
            {children}
          </a>
        )
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
          {children}
        </a>
      )
    },
    aside({ node: _node, children, ...props }) {
      const kind = (props as Record<string, unknown>)["data-callout"]
      if (!isCalloutKind(kind)) return <aside {...props}>{children}</aside>
      return (
        <Callout kind={kind} label={messages.callouts[kind]}>
          {children}
        </Callout>
      )
    },
  }
}

function SectionAnchor({
  version,
  latestVersion,
  slug,
  label,
}: {
  readonly version: ArtifactVersion
  readonly latestVersion: number
  readonly slug: string
  readonly label: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="sixb-section-anchor"
      aria-label={label}
      title={label}
      data-copied={copied ? "" : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(
            artifactLink(
              {
                type: "artifact",
                artifactId: version.artifactId,
                version: version.version,
                part: slug,
              },
              latestVersion,
              location.origin
            )
          )
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // The clipboard can be unavailable, such as on an insecure origin; the heading still links.
        }
      }}
    >
      <Link2 aria-hidden="true" />
    </button>
  )
}

const CALLOUT_ICONS: Record<CalloutKind, typeof Info> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: AlertTriangle,
  caution: OctagonAlert,
}

function Callout({
  kind,
  label,
  children,
}: {
  readonly kind: CalloutKind
  readonly label: string
  readonly children: ReactNode
}) {
  const Icon = CALLOUT_ICONS[kind]
  return (
    <aside className="sixb-callout" data-callout={kind}>
      <Icon className="sixb-callout-icon" aria-hidden="true" />
      <div className="sixb-callout-body">
        <p className="sixb-callout-label">{label}</p>
        {children}
      </div>
    </aside>
  )
}

/** A heading's words as the outline recorded them, for labels that name the section. */
function headingText(version: ArtifactVersion, slug: string): string {
  const headings = version.outline.kind === "document" ? version.outline.headings : []
  return headings.find((heading) => heading.slug === slug)?.text ?? slug
}

function isCalloutKind(value: unknown): value is CalloutKind {
  return typeof value === "string" && (CALLOUT_KINDS as readonly string[]).includes(value)
}
