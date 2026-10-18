import { getArtifactOptions, getArtifactVersionOptions } from "@sixb/client/hooks"
import {
  type ArtifactAddress,
  type CellRange,
  isArtifactAddress,
  parseArtifactAddress,
  type ResolvedArtifactPart,
  resolveArtifactAddress,
} from "@sixb/core/artifacts"
import { Markdown, type MarkdownProps } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, FileX } from "lucide-react"
import {
  type ComponentProps,
  type ComponentType,
  createContext,
  lazy,
  type MouseEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useMemo,
} from "react"
import { ArtifactCardFace } from "../card-preview"
import { ArtifactFrame } from "../frame"
import { ArtifactKindIcon } from "../kind-icon"
import { useArtifactMessages } from "../messages"
import { type ArtifactVersion, useFileText, versionFileSource } from "../queries"
import { documentComponents } from "../renderers/document"
import { rehypeArtifactDocument } from "../renderers/document-tree"
import { cellFormatter } from "../renderers/sheet/format"
import { useSheetModel, useWorkbook } from "../renderers/sheet/workbook"
import { type ArtifactTarget, artifactTargetHref } from "../target"
import {
  artifactUrlTransform,
  EMBED_ATTRIBUTE,
  rehypeArtifactEmbeds,
  rehypeKeepSection,
} from "./embed-tree"

const SheetChart = lazy(() => import("../renderers/sheet/chart"))

// Embeds come first, so a lone `artifact:` image is an embed rather than a captioned figure.
const REPLY_PLUGINS = [rehypeArtifactEmbeds]

/** A whole sheet shows its first rows; a range shows as written, up to a page of rows. */
const EMBED_ROWS = 12
const EMBED_RANGE_ROWS = 100
const EMBED_COLUMNS = 8

interface ReferenceContext {
  /** How many embeds deep this content is: an embed inside an embed shows as a link. */
  readonly depth: number
  /** Opens an artifact where the reader is, such as the panel beside a conversation. */
  readonly open?: (target: ArtifactTarget) => void
}

const References = createContext<ReferenceContext>({ depth: 0 })

/** Where `artifact:` links open, for the content inside. */
export function ArtifactReferencesProvider({
  open,
  children,
}: {
  readonly open?: (target: ArtifactTarget) => void
  readonly children: ReactNode
}) {
  const { depth } = useContext(References)
  const value = useMemo(() => ({ depth, ...(open ? { open } : {}) }), [depth, open])
  return <References.Provider value={value}>{children}</References.Provider>
}

type Components = NonNullable<MarkdownProps["components"]>

/**
 * A Markdown host's components with `artifact:` addresses resolved: an embed block shows its
 * target, and a link or an inline image opens it. Everything else goes to the host's own.
 */
export function withArtifactReferences(components: Components = {}): Components {
  const Anchor = hostComponent<"a">(components.a)
  const Image = hostComponent<"img">(components.img)
  const Block = hostComponent<"div">(components.div)
  return {
    ...components,
    div(props) {
      const address = (props as Record<string, unknown>)[EMBED_ATTRIBUTE]
      if (typeof address === "string") {
        const caption = (props as Record<string, unknown>)["data-caption"]
        return (
          <ArtifactEmbed address={address} caption={typeof caption === "string" ? caption : ""} />
        )
      }
      if (Block) return <Block {...props} />
      const { node: _node, ...rest } = props
      return <div {...rest} />
    },
    a(props) {
      if (props.href && isArtifactAddress(props.href)) {
        return <ArtifactLink address={props.href}>{props.children}</ArtifactLink>
      }
      if (Anchor) return <Anchor {...props} />
      const { node: _node, ...rest } = props
      return <a {...rest} target="_blank" rel="noreferrer noopener" />
    },
    img(props) {
      if (typeof props.src === "string" && isArtifactAddress(props.src)) {
        return <ArtifactLink address={props.src}>{props.alt || props.src}</ArtifactLink>
      }
      if (Image) return <Image {...props} />
      const { node: _node, ...rest } = props
      return <img {...rest} alt={rest.alt ?? ""} />
    },
  }
}

type HostProps<Tag extends "a" | "img" | "div"> = ComponentProps<Tag> & { readonly node?: unknown }

/** A host's own renderer for an element, when it gave one as a component rather than a tag. */
function hostComponent<Tag extends "a" | "img" | "div">(
  value: unknown
): ComponentType<HostProps<Tag>> | undefined {
  return typeof value === "function" ? (value as ComponentType<HostProps<Tag>>) : undefined
}

/**
 * Opens an address where links open: beside the conversation, or in place in the viewer. For a
 * reference that is not a link, such as one a deck's frame reports.
 */
export function useOpenArtifactAddress(): (address: string) => void {
  const { open } = useContext(References)
  return useCallback(
    (address: string) => {
      const parsed = parseArtifactAddress(address)
      if (parsed) open?.(targetOf(parsed))
    },
    [open]
  )
}

/** Markdown with `artifact:` addresses resolved, as a chat reply renders it. */
export function ReferencingMarkdown({
  children,
  className,
}: {
  readonly children: string
  readonly className?: string
}) {
  const components = useMemo(() => withArtifactReferences(), [])
  return (
    <Markdown
      className={className}
      components={components}
      rehypePlugins={REPLY_PLUGINS}
      urlTransform={artifactUrlTransform}
    >
      {children}
    </Markdown>
  )
}

/** A link to an artifact, or a part of one, that opens where the reader is. */
export function ArtifactLink({
  address,
  children,
  className,
}: {
  readonly address: string
  readonly children: ReactNode
  readonly className?: string
}) {
  const { open } = useContext(References)
  const parsed = parseArtifactAddress(address)
  if (!parsed) return <span className={className}>{children}</span>
  const target = targetOf(parsed)
  return (
    <a
      href={artifactTargetHref(target)}
      className={className}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (!open || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        open(target)
      }}
    >
      {children}
    </a>
  )
}

/** An address as a reader knows it: the artifact's title, and the part it names. */
export function ArtifactAddressLabel({ address }: { readonly address: string }) {
  const parsed = parseArtifactAddress(address)
  const { data } = useQuery({
    ...getArtifactOptions({ path: { artifactId: parsed?.artifactId ?? "" } }),
    enabled: parsed !== null,
    staleTime: 60_000,
    retry: false,
  })
  if (!parsed || !data) return <>{address}</>
  return <>{[data.artifact.title, parsed.part ?? parsed.path].filter(Boolean).join(" · ")}</>
}

/**
 * Another artifact, or a part of it, shown in place: a sheet's range as a table, a chart, a
 * document's section, an image, or the artifact itself as a card. A quiet line under it names the
 * source and the version it follows. One level deep: inside an embed, an embed is a link.
 */
export function ArtifactEmbed({
  address,
  caption,
  fill = false,
}: {
  readonly address: string
  readonly caption: string
  /**
   * Fill the box it is given, as a deck's slide gives it, with no caption or source line under
   * it: the slide says what it shows, and a corner link opens it.
   */
  readonly fill?: boolean
}) {
  const { depth, open } = useContext(References)
  const parsed = parseArtifactAddress(address)
  if (!parsed || depth > 0) {
    return (
      <p>
        <ArtifactLink address={address}>{caption || address}</ArtifactLink>
      </p>
    )
  }
  return (
    <References.Provider value={{ depth: depth + 1, ...(open ? { open } : {}) }}>
      <LoadedEmbed address={parsed} written={address} caption={caption} fill={fill} />
    </References.Provider>
  )
}

function LoadedEmbed({
  address,
  written,
  caption,
  fill,
}: {
  readonly address: ArtifactAddress
  readonly written: string
  readonly caption: string
  readonly fill: boolean
}) {
  const messages = useArtifactMessages().references
  const query = useQuery({
    ...getArtifactVersionOptions({
      path: { artifactId: address.artifactId, version: String(address.version ?? "latest") },
    }),
    // A pinned version never changes; the latest is read again when the embed mounts.
    staleTime: address.version === undefined ? 30_000 : Number.POSITIVE_INFINITY,
    retry: false,
  })
  const version = query.data
  const resolved = version
    ? resolveArtifactAddress(address, {
        kind: version.outline.kind,
        outline: version.outline,
        files: version.files,
      })
    : null
  if (fill) {
    return (
      <FilledFigure {...(version ? { address: written } : {})}>
        {!version || !resolved ? (
          <Pending loading={query.isLoading} fill />
        ) : "problem" in resolved ? (
          <Unavailable
            title={messages.unavailable}
            description={messages.missingPart(version.title)}
          />
        ) : (
          <EmbedBody
            part={resolved.part}
            version={version}
            address={written}
            caption={caption}
            fill
          />
        )}
      </FilledFigure>
    )
  }
  if (!version || !resolved) {
    return (
      <Figure caption={caption}>
        <Pending loading={query.isLoading} />
      </Figure>
    )
  }
  if ("problem" in resolved) {
    return (
      <Figure
        caption={caption}
        source={<Source address={written} version={version} pinned={address.version} />}
      >
        <Unavailable
          title={messages.unavailable}
          description={messages.missingPart(version.title)}
        />
      </Figure>
    )
  }
  return (
    <Figure
      caption={caption}
      source={
        <Source
          address={written}
          version={version}
          pinned={address.version}
          part={partLabel(resolved.part, version)}
        />
      }
      bare={resolved.part.type === "file" || resolved.part.type === "artifact"}
    >
      <EmbedBody part={resolved.part} version={version} address={written} caption={caption} />
    </Figure>
  )
}

function EmbedBody({
  part,
  version,
  address,
  caption,
  fill = false,
}: {
  readonly part: ResolvedArtifactPart
  readonly version: ArtifactVersion
  readonly address: string
  readonly caption: string
  readonly fill?: boolean
}) {
  switch (part.type) {
    case "sheet":
      return <SheetEmbed version={version} sheet={part.sheet} range={part.range} />
    case "chart":
      return <ChartEmbed version={version} chart={part.chart} fill={fill} />
    case "section":
      return <SectionEmbed version={version} slug={part.slug} />
    case "file":
      return (
        <FileEmbed
          version={version}
          path={part.path}
          address={address}
          caption={caption}
          fill={fill}
        />
      )
    case "slide":
      return <SlideEmbed version={version} slide={part.slide} fill={fill} />
    case "artifact":
      return version.outline.kind === "slides" ? (
        <SlideEmbed version={version} slide={1} fill={fill} />
      ) : (
        <CardEmbed version={version} address={address} />
      )
  }
}

function SheetEmbed({
  version,
  sheet,
  range,
}: {
  readonly version: ArtifactVersion
  readonly sheet: string
  readonly range?: CellRange
}) {
  const locale = useLocale()
  const messages = useArtifactMessages().references
  const { workbook, loading } = useWorkbook(version)
  const csv = useSheetModel(
    version,
    workbook?.sheets.find((entry) => entry.name === sheet)
  )
  const { model } = csv
  if (!model) return <Pending loading={loading || csv.loading} />
  const left = range?.left ?? 0
  const right = range ? range.right : Math.min(model.columns.length, EMBED_COLUMNS) - 1
  const columns = model.columns.slice(left, right + 1)
  // Row 1 is the header, which a table always shows; the range picks the data rows under it.
  const first = Math.max(1, range?.top ?? 1) - 1
  const last = range ? range.bottom - 1 : model.rows.length - 1
  const total = Math.max(0, last - first + 1)
  const rows = model.rows.slice(
    first,
    first + Math.min(total, range ? EMBED_RANGE_ROWS : EMBED_ROWS)
  )
  const hidden = total - rows.length
  const formatters = columns.map((column) => cellFormatter(column, locale))
  return (
    <div className="overflow-x-auto">
      <table className="sixb-embed-table w-full border-collapse tabular-nums">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.name} data-numeric={column.numeric ? "" : undefined}>
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${first + rowIndex}`}>
              {columns.map((column, index) => {
                const cell = formatters[index]?.(row[left + index] ?? "") ?? { text: "" }
                return (
                  <td
                    key={column.name}
                    data-numeric={column.numeric ? "" : undefined}
                    className={cn(cell.negative && "text-destructive")}
                  >
                    {cell.text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <p className="m-0 border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          {messages.moreRows(hidden)}
        </p>
      ) : null}
    </div>
  )
}

function ChartEmbed({
  version,
  chart,
  fill = false,
}: {
  readonly version: ArtifactVersion
  readonly chart: string
  readonly fill?: boolean
}) {
  const locale = useLocale()
  const { workbook, loading } = useWorkbook(version)
  const declared = workbook?.charts.find((entry) => entry.name === chart)
  const csv = useSheetModel(
    version,
    workbook?.sheets.find((entry) => entry.name === declared?.sheet)
  )
  const { model } = csv
  if (!declared || !model) return <Pending loading={loading || csv.loading} />
  return (
    <div className={cn("px-3 pt-3 pb-2", fill ? "h-full" : "h-64")}>
      <Suspense fallback={<div className="h-full animate-pulse rounded-lg bg-muted/50" />}>
        <SheetChart chart={declared} model={model} locale={locale} />
      </Suspense>
    </div>
  )
}

function SectionEmbed({
  version,
  slug,
}: {
  readonly version: ArtifactVersion
  readonly slug: string
}) {
  const { text, loading } = useFileText(versionFileSource(version, version.entry))
  // The whole document renders, and only the section stays: its headings get the ids publishing
  // named them by, so the slug finds the same heading the reader sees.
  const plugins = useMemo(
    () => [rehypeArtifactEmbeds, rehypeArtifactDocument, rehypeKeepSection(slug)],
    [slug]
  )
  const messages = useArtifactMessages().document
  // The section shapes as its document does: callouts, figures, and columns of figures.
  const components = useMemo(
    () =>
      withArtifactReferences(
        documentComponents(version, version.version, messages, (target) =>
          document.getElementById(target)?.scrollIntoView({ block: "start" })
        )
      ),
    [version, messages]
  )
  if (text === undefined) return <Pending loading={loading} />
  return (
    <div className="sixb-embed-section px-5 py-4">
      <Markdown
        className="sixb-document"
        components={components}
        rehypePlugins={plugins}
        urlTransform={artifactUrlTransform}
      >
        {text}
      </Markdown>
    </div>
  )
}

/** One slide of a deck, live in its frame. */
function SlideEmbed({
  version,
  slide,
  fill = false,
}: {
  readonly version: ArtifactVersion
  readonly slide: number
  readonly fill?: boolean
}) {
  return (
    <ArtifactFrame
      version={version}
      title={version.title}
      start={{ slide, fill: true }}
      className={
        fill
          ? "size-full bg-background"
          : "aspect-video w-full overflow-hidden rounded-xl border border-border bg-background"
      }
    />
  )
}

function FileEmbed({
  version,
  path,
  address,
  caption,
  fill = false,
}: {
  readonly version: ArtifactVersion
  readonly path: string
  readonly address: string
  readonly caption: string
  readonly fill?: boolean
}) {
  const source = versionFileSource(version, path)
  if (source?.fileRef.mediaType?.startsWith("image/")) {
    return (
      <img
        src={source.inlineUrl}
        alt={caption}
        loading="lazy"
        className={cn(
          "m-0 block",
          fill ? "size-full object-contain" : "h-auto max-w-full rounded-xl"
        )}
      />
    )
  }
  return <CardEmbed version={version} address={address} />
}

/** The artifact itself, as a card that opens it. */
function CardEmbed({
  version,
  address,
}: {
  readonly version: ArtifactVersion
  readonly address: string
}) {
  return (
    <ArtifactLink
      address={address}
      className="sixb-embed-card group flex max-w-sm flex-col overflow-hidden rounded-xl border border-border/80 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-[0_4px_14px_rgb(0_0_0/0.07)]"
    >
      <ArtifactCardFace
        kind={version.outline.kind}
        title={version.title}
        version={version}
        loading={false}
      />
    </ArtifactLink>
  )
}

/** An embed filling a deck's box: framed as a card, with a corner link that opens it. */
function FilledFigure({
  address,
  children,
}: {
  readonly address?: string
  readonly children: ReactNode
}) {
  const messages = useArtifactMessages().references
  return (
    <div className="sixb-embed-filled group/embed relative flex size-full flex-col overflow-hidden rounded-xl border border-border/70 bg-card text-foreground">
      <div className="min-h-0 flex-1 overflow-hidden [&>*]:h-full">{children}</div>
      {address ? (
        <ArtifactLink
          address={address}
          className="absolute top-2 right-2 inline-flex items-center gap-0.5 rounded-md bg-background/90 px-1.5 py-0.5 font-medium text-[11px] text-foreground/80 opacity-0 shadow-sm ring-1 ring-border/70 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/embed:opacity-100"
        >
          {messages.open}
          <ArrowUpRight className="size-3" aria-hidden="true" />
        </ArtifactLink>
      ) : null}
    </div>
  )
}

function Figure({
  caption,
  source,
  bare = false,
  children,
}: {
  readonly caption: string
  readonly source?: ReactNode
  /** An image or a card frames itself. */
  readonly bare?: boolean
  readonly children: ReactNode
}) {
  return (
    <figure className="sixb-embed my-6">
      <div className={cn(!bare && "overflow-hidden rounded-xl border border-border/70 bg-card")}>
        {children}
      </div>
      {caption || source ? (
        <figcaption className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {caption ? <span className="text-[13px] text-foreground/80">{caption}</span> : <span />}
          {source}
        </figcaption>
      ) : null}
    </figure>
  )
}

/** Where an embed comes from: the artifact, the part, the version it follows, and a way to it. */
function Source({
  address,
  version,
  pinned,
  part,
}: {
  readonly address: string
  readonly version: ArtifactVersion
  readonly pinned: number | undefined
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <ArtifactKindIcon kind={version.outline.kind} className="size-3.5 shrink-0" />
      <span className="truncate">
        {[
          version.title,
          part,
          pinned === undefined ? messages.references.latest : messages.viewer.versionLabel(pinned),
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <ArtifactLink
        address={address}
        className="sixb-embed-source inline-flex shrink-0 items-center gap-0.5 font-medium text-foreground/80 hover:text-foreground"
      >
        {messages.references.open}
        <ArrowUpRight className="size-3" aria-hidden="true" />
      </ArtifactLink>
    </span>
  )
}

function Unavailable({
  title,
  description,
}: {
  readonly title: string
  readonly description: string
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-5 text-sm">
      <FileX className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="flex flex-col">
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-muted-foreground">{description}</span>
      </span>
    </div>
  )
}

function Pending({
  loading,
  fill = false,
}: {
  readonly loading: boolean
  readonly fill?: boolean
}) {
  const messages = useArtifactMessages().references
  return loading ? (
    <div
      className={cn("animate-pulse bg-muted/50", fill ? "h-full" : "h-32")}
      aria-label={messages.loading}
    />
  ) : (
    <Unavailable title={messages.unavailable} description={messages.unavailableDescription} />
  )
}

/** The part an embed shows, named for its source line: a sheet's range, a chart, a section. */
function partLabel(part: ResolvedArtifactPart, version: ArtifactVersion): string | undefined {
  switch (part.type) {
    case "sheet":
      return part.range ? undefined : part.sheet
    case "chart":
      // A chart's name is an id; the caption says what it shows.
      return undefined
    case "section": {
      const { outline } = version
      return outline.kind === "document"
        ? outline.headings.find((heading) => heading.slug === part.slug)?.text
        : undefined
    }
    case "slide":
      return String(part.slide)
    case "file":
      return part.path
    case "artifact":
      return undefined
  }
}

/** Where a link to the address opens: its artifact, version, and the part to show first. */
function targetOf(address: ArtifactAddress): ArtifactTarget {
  return {
    type: "artifact",
    artifactId: address.artifactId,
    ...(address.version === undefined ? {} : { version: address.version }),
    ...(address.part === undefined ? {} : { part: address.part }),
  }
}
