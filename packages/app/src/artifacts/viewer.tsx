import { type GetArtifactResponse, isSixbApiError } from "@sixb/client"
import { getArtifactOptions, getArtifactVersionOptions } from "@sixb/client/hooks"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Link2,
  Maximize2,
  X,
} from "lucide-react"
import { type ReactNode, useState } from "react"
import { Link } from "react-router-dom"
import { formatFileSize } from "./file-size"
import type { ArtifactKindName } from "./kind-icon"
import { useArtifactMessages } from "./messages"
import { type ArtifactVersion, versionFileSource } from "./queries"
import { ArtifactReferencesProvider } from "./references/references"
import { DocumentRenderer } from "./renderers/document"
import { FileRenderer } from "./renderers/file"
import { ViewerLoading, ViewerNotice } from "./renderers/notice"
import { SheetRenderer } from "./renderers/sheet/sheet"
import { type ArtifactTarget, artifactLink, type ViewerTarget } from "./target"

export interface ViewerChrome {
  /** Show a close button that calls this. */
  readonly onClose?: () => void
  /** Show a back button that calls this, on the full page. */
  readonly onBack?: () => void
  /** Where "open full page" goes, as a route in the app; omitted on the full page itself. */
  readonly fullPageHref?: string
}

/** An artifact or a file under its header. One viewer serves the panel, the dialog, and the page. */
export function Viewer({
  target,
  onTargetChange,
  onOpenReference = onTargetChange,
  chrome = {},
  className,
}: {
  readonly target: ViewerTarget
  readonly onTargetChange: (target: ViewerTarget) => void
  /** Opens an artifact this one shows or links to; a host can remember the way back. */
  readonly onOpenReference?: (target: ArtifactTarget) => void
  readonly chrome?: ViewerChrome
  readonly className?: string
}) {
  return (
    <div className={cn("flex h-full min-h-0 min-w-0 flex-col bg-background", className)}>
      {target.type === "artifact" ? (
        // A link to another artifact opens it here, in place of this one.
        <ArtifactReferencesProvider open={onOpenReference}>
          <ArtifactView target={target} onTargetChange={onTargetChange} chrome={chrome} />
        </ArtifactReferencesProvider>
      ) : (
        <>
          <FileHeader target={target} chrome={chrome} />
          <FileRenderer source={target.source} />
        </>
      )}
    </div>
  )
}

function ArtifactView({
  target,
  onTargetChange,
  chrome,
}: {
  readonly target: ArtifactTarget
  readonly onTargetChange: (target: ViewerTarget) => void
  readonly chrome: ViewerChrome
}) {
  const messages = useArtifactMessages().viewer
  const artifactQuery = useQuery({
    ...getArtifactOptions({ path: { artifactId: target.artifactId } }),
    retry: false,
  })
  const detail = artifactQuery.data
  const versionNumber = target.version ?? detail?.artifact.latestVersion
  const versionQuery = useQuery({
    ...getArtifactVersionOptions({
      path: { artifactId: target.artifactId, version: String(versionNumber ?? "latest") },
    }),
    enabled: versionNumber !== undefined,
    // A version never changes once published.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const error = artifactQuery.error ?? versionQuery.error

  if (error || (artifactQuery.isSuccess && !detail)) {
    const notFound = isSixbApiError(error) && error.status === 404
    return (
      <>
        <ViewerBar chrome={chrome} />
        <ViewerNotice
          title={notFound ? messages.notFound : messages.loadFailed}
          description={
            notFound
              ? messages.notFoundDescription
              : isSixbApiError(error) && error.status === 501
                ? messages.storageUnavailable
                : undefined
          }
        />
      </>
    )
  }
  if (!detail || !versionQuery.data) {
    return (
      <>
        <ViewerBar chrome={chrome} />
        <ViewerLoading label={messages.loading} />
      </>
    )
  }

  const version = versionQuery.data
  return (
    <>
      <ArtifactHeader
        target={target}
        detail={detail}
        version={version}
        chrome={chrome}
        onVersionChange={(next) =>
          onTargetChange({
            type: "artifact",
            artifactId: target.artifactId,
            ...(next === detail.artifact.latestVersion ? {} : { version: next }),
          })
        }
      />
      <ArtifactBody
        version={version}
        kind={detail.artifact.kind}
        latestVersion={detail.artifact.latestVersion}
        part={target.part}
      />
    </>
  )
}

/** The kind's renderer for one version. */
function ArtifactBody({
  version,
  kind,
  latestVersion,
  part,
}: {
  readonly version: ArtifactVersion
  readonly kind: ArtifactKindName
  readonly latestVersion: number
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  if (kind === "document") {
    return <DocumentRenderer version={version} latestVersion={latestVersion} part={part} />
  }
  if (kind === "sheet") return <SheetRenderer version={version} part={part} />
  if (kind === "file") {
    const source = versionFileSource(version, version.entry)
    return source ? (
      <FileRenderer source={source} />
    ) : (
      <ViewerNotice title={messages.viewer.loadFailed} />
    )
  }
  return (
    <ViewerNotice title={messages.viewer.unsupportedKind(messages.kinds[kind].toLowerCase())} />
  )
}

type ArtifactDetail = GetArtifactResponse

function ArtifactHeader({
  target,
  detail,
  version,
  chrome,
  onVersionChange,
}: {
  readonly target: ArtifactTarget
  readonly detail: ArtifactDetail
  readonly version: ArtifactVersion
  readonly chrome: ViewerChrome
  readonly onVersionChange: (version: number) => void
}) {
  const messages = useArtifactMessages()
  const locale = useLocale()
  const { artifact } = detail
  // A sheet downloads each sheet as CSV from its tabs; its entry is only the workbook.
  const download = artifact.kind === "sheet" ? null : versionFileSource(version, version.entry)
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })

  return (
    <ViewerBar
      chrome={chrome}
      title={version.title}
      meta={
        <>
          <span>{messages.kinds[artifact.kind]}</span>
          <span aria-hidden="true">·</span>
          <DropdownMenu>
            <DropdownMenuTrigger className="-mx-1 inline-flex items-center gap-0.5 rounded-md px-1 tabular-nums outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground">
              {messages.viewer.versionLabel(version.version)}
              <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-60">
              <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                {messages.viewer.versions}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={String(version.version)}
                onValueChange={(value) => onVersionChange(Number(value))}
              >
                {detail.versions.map((entry) => (
                  <DropdownMenuRadioItem key={entry.version} value={String(entry.version)}>
                    <span className="flex-1 tabular-nums">
                      {messages.viewer.versionItem(entry.version, date(entry.createdAt))}
                    </span>
                    {entry.version === artifact.latestVersion ? (
                      <span className="text-xs text-muted-foreground">
                        {messages.viewer.latest}
                      </span>
                    ) : null}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <CopyLinkButton link={() => artifactLink(target, artifact.latestVersion, location.origin)} />
      {download ? (
        <HeaderLink
          href={download.downloadUrl}
          download={download.name}
          label={messages.viewer.download(download.name)}
        >
          <ArrowDownToLine />
        </HeaderLink>
      ) : null}
    </ViewerBar>
  )
}

function FileHeader({
  target,
  chrome,
}: {
  readonly target: Extract<ViewerTarget, { type: "file" }>
  readonly chrome: ViewerChrome
}) {
  const messages = useArtifactMessages()
  const locale = useLocale()
  const { source } = target
  return (
    <ViewerBar
      chrome={{ ...(chrome.onClose ? { onClose: chrome.onClose } : {}) }}
      title={source.name}
      meta={
        <span className="tabular-nums">
          {formatFileSize(source.fileRef.sizeBytes, locale, messages.files)}
        </span>
      }
    >
      <HeaderLink
        href={source.inlineUrl}
        target="_blank"
        label={messages.viewer.openInNewTab(source.name)}
      >
        <ArrowUpRight />
      </HeaderLink>
      <HeaderLink
        href={source.downloadUrl}
        download={source.name}
        label={messages.viewer.download(source.name)}
      >
        <ArrowDownToLine />
      </HeaderLink>
    </ViewerBar>
  )
}

/**
 * The header: back on the full page, the title over a quiet line of what it is, then the actions,
 * full page, and close.
 */
function ViewerBar({
  chrome,
  title,
  meta,
  children,
}: {
  readonly chrome: ViewerChrome
  readonly title?: string
  readonly meta?: ReactNode
  readonly children?: ReactNode
}) {
  const messages = useArtifactMessages().viewer
  return (
    <TooltipProvider delayDuration={400}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-3 print:hidden">
        {chrome.onBack ? (
          <HeaderButton label={messages.back} onClick={chrome.onBack}>
            <ArrowLeft />
          </HeaderButton>
        ) : null}
        <div
          className={cn("flex min-w-0 flex-1 flex-col justify-center", !chrome.onBack && "pl-1.5")}
        >
          {title ? (
            <h2
              className="truncate text-[14.5px] leading-tight font-semibold tracking-[-0.01em] text-foreground"
              title={title}
            >
              {title}
            </h2>
          ) : null}
          {meta ? (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] leading-tight text-muted-foreground">
              {meta}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {children}
          {chrome.fullPageHref ? (
            <HeaderLink to={chrome.fullPageHref} label={messages.openFullPage}>
              <Maximize2 />
            </HeaderLink>
          ) : null}
          {chrome.onClose ? (
            <>
              <span className="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />
              <HeaderButton label={messages.close} onClick={chrome.onClose}>
                <X />
              </HeaderButton>
            </>
          ) : null}
        </div>
      </header>
    </TooltipProvider>
  )
}

const HEADER_ACTION =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[17px] [&_svg]:stroke-[1.75]"

function HeaderTooltip({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <HeaderTooltip label={label}>
      <button type="button" className={HEADER_ACTION} onClick={onClick} aria-label={label}>
        {children}
      </button>
    </HeaderTooltip>
  )
}

/** An action that goes somewhere: a route in the app, or a file to open or download. */
function HeaderLink({
  label,
  to,
  href,
  download,
  target,
  children,
}: {
  readonly label: string
  readonly to?: string
  readonly href?: string
  readonly download?: string
  readonly target?: "_blank"
  readonly children: ReactNode
}) {
  return (
    <HeaderTooltip label={label}>
      {to ? (
        <Link to={to} className={HEADER_ACTION} aria-label={label}>
          {children}
        </Link>
      ) : (
        <a
          href={href}
          download={download}
          target={target}
          rel={target ? "noreferrer" : undefined}
          className={HEADER_ACTION}
          aria-label={label}
        >
          {children}
        </a>
      )}
    </HeaderTooltip>
  )
}

/** Copies a link to the artifact's page, and says so for a moment. */
function CopyLinkButton({ link }: { readonly link: () => string }) {
  const messages = useArtifactMessages().viewer
  const [copied, setCopied] = useState(false)
  const label = copied ? messages.linkCopied : messages.copyLink
  return (
    <HeaderButton
      label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(link())
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          // The clipboard can be unavailable, such as on an insecure origin.
        }
      }}
    >
      {copied ? <Check /> : <Link2 />}
    </HeaderButton>
  )
}
