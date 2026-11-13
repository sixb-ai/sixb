import { Markdown, type MarkdownProps } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  AlertTriangle,
  Info,
  Lightbulb,
  Link2,
  MessageSquareWarning,
  OctagonAlert,
} from "lucide-react"
import { type ComponentProps, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react"
import { useCopyFeedback } from "../copy-feedback"
import { type ArtifactMessages, useArtifactMessages } from "../messages"
import {
  type ArtifactVersion,
  useFileText,
  versionFileSource,
  versionImageSource,
} from "../queries"
import { artifactUrlTransform, rehypeArtifactEmbeds } from "../references/embed-tree"
import { withArtifactReferences } from "../references/references"
import { artifactLink } from "../target"
import { useArtifactThemeAttributes } from "../theme"
import { CALLOUT_KINDS, type CalloutKind, rehypeArtifactDocument } from "./document-tree"
import { ViewerLoading, ViewerNotice } from "./notice"

// Embeds first, so an artifact shown alone in its paragraph is an embed, not a captioned figure.
const REHYPE_PLUGINS: MarkdownProps["rehypePlugins"] = [
  rehypeArtifactEmbeds,
  rehypeArtifactDocument,
]

/**
 * A document as a page to read: its title and lede, a measured column, figures with captions,
 * and callouts. It draws only on theme tokens, so the app's
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
  const source = versionFileSource(version, version.entry)
  const file = useFileText(source)
  const theme = useArtifactThemeAttributes(version)
  const scrollRef = useRef<HTMLDivElement | null>(null)

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
    () =>
      withArtifactReferences(
        documentComponents(version, latestVersion, messages.document, scrollToSection)
      ),
    [version, latestVersion, messages.document, scrollToSection]
  )

  if (!source) return <ViewerNotice title={messages.viewer.loadFailed} />
  if (file.loading) return <ViewerLoading label={messages.viewer.loading} />
  if (file.tooLarge || file.error || file.text === undefined) {
    return <ViewerNotice title={file.error ? messages.files[file.error] : messages.files.noText} />
  }

  return (
    <div
      ref={scrollRef}
      data-sixb-artifact=""
      className={cn(
        "@container min-h-0 flex-1 overflow-y-auto bg-background text-foreground",
        theme.className
      )}
      style={theme.style}
    >
      <div className="sixb-document-page">
        <Markdown
          className="sixb-document"
          components={components}
          rehypePlugins={REHYPE_PLUGINS}
          urlTransform={artifactUrlTransform}
        >
          {file.text}
        </Markdown>
      </div>
    </div>
  )
}

export function documentComponents(
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
  const { copied, copy } = useCopyFeedback()
  return (
    <button
      type="button"
      className="sixb-section-anchor"
      aria-label={label}
      title={label}
      data-copied={copied ? "" : undefined}
      onClick={() => {
        copy(
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
