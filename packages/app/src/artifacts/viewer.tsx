import { type GetArtifactResponse, isSixbApiError } from "@sixb/client"
import { getArtifactOptions, getArtifactVersionOptions } from "@sixb/client/hooks"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  File as FileIcon,
  Link2,
  Maximize2,
  X,
} from "lucide-react"
import { type ReactNode, useState } from "react"
import { formatFileSize } from "./file-size"
import { ArtifactKindIcon, type ArtifactKindName } from "./kind-icon"
import { useArtifactMessages } from "./messages"
import { type ArtifactVersion, versionFileSource } from "./queries"
import { DocumentRenderer } from "./renderers/document"
import { FileRenderer } from "./renderers/file"
import { ViewerLoading, ViewerNotice } from "./renderers/notice"
import { type ArtifactTarget, artifactAddress, type ViewerTarget } from "./target"

export interface ViewerChrome {
  /** Show a close button that calls this. */
  readonly onClose?: () => void
  /** Where "open full page" goes; omitted on the full page itself. */
  readonly fullPageHref?: string
}

/** An artifact or a file under its header. One viewer serves the panel, the dialog, and the page. */
export function Viewer({
  target,
  onTargetChange,
  chrome = {},
  className,
}: {
  readonly target: ViewerTarget
  readonly onTargetChange: (target: ViewerTarget) => void
  readonly chrome?: ViewerChrome
  readonly className?: string
}) {
  return (
    <div className={cn("flex h-full min-h-0 min-w-0 flex-col bg-background", className)}>
      {target.type === "artifact" ? (
        <ArtifactView target={target} onTargetChange={onTargetChange} chrome={chrome} />
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
      <ArtifactBody version={version} kind={detail.artifact.kind} part={target.part} />
    </>
  )
}

/** The kind's renderer for one version. */
function ArtifactBody({
  version,
  kind,
  part,
}: {
  readonly version: ArtifactVersion
  readonly kind: ArtifactKindName
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  if (kind === "document") return <DocumentRenderer version={version} part={part} />
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
  const download = versionFileSource(version, version.entry)
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })

  return (
    <ViewerBar chrome={chrome}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <ArtifactKindIcon kind={artifact.kind} className="size-4" />
      </span>
      <h2 className="min-w-0 truncate text-sm font-semibold" title={version.title}>
        {version.title}
      </h2>
      <span className="shrink-0 text-[13px] text-muted-foreground max-sm:hidden">
        {messages.kinds[artifact.kind]}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" className="shrink-0 gap-0.5 tabular-nums">
            {messages.viewer.version(version.version)}
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuLabel>{messages.viewer.versions}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(version.version)}
            onValueChange={(value) => onVersionChange(Number(value))}
          >
            {detail.versions.map((entry) => (
              <DropdownMenuRadioItem key={entry.version} value={String(entry.version)}>
                <span className="flex-1">
                  {messages.viewer.versionItem(entry.version, date(entry.createdAt))}
                </span>
                {entry.version === artifact.latestVersion ? (
                  <span className="text-xs text-muted-foreground">{messages.viewer.latest}</span>
                ) : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="flex-1" />
      <CopyAddressButton address={artifactAddress(target, artifact.latestVersion)} />
      {download ? (
        <IconLink
          href={download.downloadUrl}
          download={download.name}
          label={messages.viewer.download(download.name)}
        >
          <Download />
        </IconLink>
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
    <ViewerBar chrome={{ onClose: chrome.onClose }}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <FileIcon className="size-4" aria-hidden="true" />
      </span>
      <h2 className="min-w-0 truncate text-sm font-semibold" title={source.name}>
        {source.name}
      </h2>
      <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums max-sm:hidden">
        {formatFileSize(source.fileRef.sizeBytes, locale, messages.files)}
      </span>
      <span className="flex-1" />
      <IconLink
        href={source.inlineUrl}
        target="_blank"
        label={messages.viewer.openInNewTab(source.name)}
      >
        <ExternalLink />
      </IconLink>
      <IconLink
        href={source.downloadUrl}
        download={source.name}
        label={messages.viewer.download(source.name)}
      >
        <Download />
      </IconLink>
    </ViewerBar>
  )
}

/** The header row: the caller's content, then full page and close. */
function ViewerBar({
  chrome,
  children,
}: {
  readonly chrome: ViewerChrome
  readonly children?: ReactNode
}) {
  const messages = useArtifactMessages().viewer
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border pr-2 pl-3.5 print:hidden">
      {children ?? <span className="flex-1" />}
      {chrome.fullPageHref ? (
        <IconLink href={chrome.fullPageHref} label={messages.openFullPage}>
          <Maximize2 />
        </IconLink>
      ) : null}
      {chrome.onClose ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={chrome.onClose}
          aria-label={messages.close}
          title={messages.close}
        >
          <X />
        </Button>
      ) : null}
    </header>
  )
}

function CopyAddressButton({ address }: { readonly address: string }) {
  const messages = useArtifactMessages().viewer
  const [copied, setCopied] = useState(false)
  const label = copied ? messages.addressCopied : messages.copyAddress
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={`${label}: ${address}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // The clipboard can be unavailable, such as on an insecure origin.
        }
      }}
    >
      {copied ? <Check /> : <Link2 />}
    </Button>
  )
}

function IconLink({
  href,
  label,
  download,
  target,
  children,
}: {
  readonly href: string
  readonly label: string
  readonly download?: string
  readonly target?: "_blank"
  readonly children: ReactNode
}) {
  return (
    <Button variant="ghost" size="icon-sm" asChild>
      <a
        href={href}
        download={download}
        target={target}
        rel={target ? "noreferrer" : undefined}
        aria-label={label}
        title={label}
      >
        {children}
      </a>
    </Button>
  )
}
