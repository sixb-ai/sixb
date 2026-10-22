import { type GetArtifactResponse, isSixbApiError } from "@sixb/client"
import {
  getArtifactOptions,
  getArtifactQueryKey,
  getArtifactVersionOptions,
} from "@sixb/client/hooks"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
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
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Link2,
  LoaderCircle,
  Maximize2,
  PencilLine,
  Redo2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useCurrentUser } from "../session"
import { useCopyFeedback } from "./copy-feedback"
import { DownloadMenu } from "./downloads"
import { type ArtifactDraft, EditSessionProvider, saveDraft } from "./edit-session"
import { formatFileSize } from "./file-size"
import { useFileName } from "./file-source"
import { FileTypeIcon, fileTypeOf } from "./file-type-icon"
import { type ArtifactKindName, ArtifactKindTile } from "./kind-icon"
import { useArtifactMessages } from "./messages"
import { type ArtifactMoved, ArtifactMovedError } from "./publish-edit"
import { type ArtifactVersion, versionFileSource } from "./queries"
import { ArtifactReferencesProvider } from "./references/references"
import { CanvasRenderer } from "./renderers/canvas/renderer"
import { DocumentRenderer } from "./renderers/document"
import { FileRenderer } from "./renderers/file"
import { ViewerLoading, ViewerNotice } from "./renderers/notice"
import { PageRenderer } from "./renderers/page"
import { useWorkbookDownloads } from "./renderers/sheet/downloads"
import { SheetRenderer } from "./renderers/sheet/sheet"
import { SlidesRenderer } from "./renderers/slides/slides"
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
          {/* An edit belongs to its artifact: another one opens without it. */}
          <ArtifactView
            key={target.artifactId}
            target={target}
            onTargetChange={onTargetChange}
            chrome={chrome}
          />
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
  const edit = useArtifactEdit(target, detail, versionQuery.data, onTargetChange)
  const guarded = edit.guard(chrome)

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
  const kind = detail.artifact.kind
  return (
    <>
      <ArtifactHeader
        target={target}
        detail={detail}
        version={version}
        chrome={guarded}
        edit={edit}
        onVersionChange={(next) =>
          onTargetChange({
            type: "artifact",
            artifactId: target.artifactId,
            ...(next === detail.artifact.latestVersion ? {} : { version: next }),
          })
        }
      />
      {edit.saving.state === "moved" || edit.saving.state === "failed" ? (
        <EditNotice edit={edit} />
      ) : null}
      <EditSessionProvider editing={edit.editing} report={edit.report}>
        <ArtifactBody
          key={bodyKey(version, kind, target.part)}
          version={version}
          kind={kind}
          latestVersion={detail.artifact.latestVersion}
          part={target.part}
        />
      </EditSessionProvider>
      <DiscardDialog edit={edit} />
    </>
  )
}

/** The kinds a reader edits in place; the rest are the Agent's to change. */
const EDITABLE_KINDS: ReadonlySet<ArtifactKindName> = new Set(["sheet", "canvas"])

type SaveState =
  | { readonly state: "idle" | "saving" }
  /** `refused`: why publishing refused the draft, in its words, when it did. */
  | { readonly state: "failed"; readonly refused?: string }
  | { readonly state: "moved"; readonly latest: ArtifactMoved }

/** Editing the version shown: whether it can be, the draft, and saving it as the next version. */
interface ArtifactEdit {
  /** Whether the reader may edit what is shown: the latest version of a kind that edits. */
  readonly available: boolean
  readonly editing: boolean
  readonly changed: boolean
  readonly saving: SaveState
  /** Takes back the draft's last change; absent when there is none. */
  readonly undo?: () => void
  readonly redo?: () => void
  /** The version a save publishes. */
  readonly next: number
  readonly start: () => void
  readonly report: (draft: ArtifactDraft | null) => void
  /** Saves the draft as the next version; over `baseVersion`, when the reader chose to. */
  readonly save: (baseVersion?: number) => Promise<void>
  /** Leaves editing, asking first when the draft has changes. */
  readonly discard: () => void
  /** Leaves editing for the latest version, the draft dropped. */
  readonly openLatest: () => void
  /** Whether the discard confirmation is open, and what it continues with. */
  readonly confirming: (() => void) | null
  readonly confirm: (then: (() => void) | null) => void
  /** The header's close and back, asking first when the draft has changes. */
  readonly guard: (chrome: ViewerChrome) => ViewerChrome
}

function useArtifactEdit(
  target: ArtifactTarget,
  detail: ArtifactDetail | undefined,
  version: ArtifactVersion | undefined,
  onTargetChange: (target: ViewerTarget) => void
): ArtifactEdit {
  const queries = useQueryClient()
  const user = useCurrentUser()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ArtifactDraft | null>(null)
  const [saving, setSaving] = useState<SaveState>({ state: "idle" })
  const [confirming, setConfirming] = useState<(() => void) | null>(null)
  const artifact = detail?.artifact
  // The owner publishes; with sign-in off, everyone does.
  const owns = !user || (artifact?.owner.type === "user" && artifact.owner.id === user.id) || false
  const available =
    !!artifact &&
    !!version &&
    EDITABLE_KINDS.has(artifact.kind) &&
    version.version === artifact.latestVersion &&
    owns
  const changed = editing && !!draft?.changed

  const stop = useCallback(() => {
    setEditing(false)
    setDraft(null)
    setSaving({ state: "idle" })
  }, [])

  const save = useCallback(
    async (over?: number) => {
      if (!version || !draft?.changed || saving.state === "saving") return
      // Once a save has met a later version, saving again is saving over it, as the notice says.
      const baseVersion = over ?? (saving.state === "moved" ? saving.latest.version : undefined)
      setSaving({ state: "saving" })
      try {
        await saveDraft(queries, version, draft, baseVersion === undefined ? {} : { baseVersion })
        // The artifact's latest version is the one just saved: the view moves to it.
        await queries.invalidateQueries({
          queryKey: getArtifactQueryKey({ path: { artifactId: version.artifactId } }),
        })
        void queries.invalidateQueries({
          predicate: (query) =>
            (query.queryKey[0] as { _id?: string } | undefined)?._id === "listArtifacts",
        })
        stop()
        onTargetChange({ type: "artifact", artifactId: version.artifactId })
      } catch (error) {
        const refused = publishRefusal(error)
        setSaving(
          error instanceof ArtifactMovedError
            ? { state: "moved", latest: error.latest }
            : { state: "failed", ...(refused ? { refused } : {}) }
        )
      }
    },
    [version, draft, saving, queries, stop, onTargetChange]
  )

  // ⌘S saves, as an editor's does; leaving the page with changes asks first.
  useEffect(() => {
    if (!editing) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [editing, save])
  useEffect(() => {
    if (!changed) return
    const onLeave = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", onLeave)
    return () => window.removeEventListener("beforeunload", onLeave)
  }, [changed])

  const ask = (then: () => void) => (changed ? setConfirming(() => then) : then())
  return {
    available,
    editing,
    changed,
    saving,
    ...(editing && draft?.undo ? { undo: draft.undo } : {}),
    ...(editing && draft?.redo ? { redo: draft.redo } : {}),
    next: (saving.state === "moved" ? saving.latest.version : (artifact?.latestVersion ?? 0)) + 1,
    start: () => {
      setSaving({ state: "idle" })
      setEditing(true)
    },
    report: setDraft,
    save,
    discard: () => ask(stop),
    openLatest: () => {
      stop()
      void queries.invalidateQueries({
        queryKey: getArtifactQueryKey({ path: { artifactId: target.artifactId } }),
      })
      onTargetChange({ type: "artifact", artifactId: target.artifactId })
    },
    confirming,
    confirm: setConfirming,
    guard: (chrome) => ({
      ...chrome,
      ...(chrome.onClose ? { onClose: () => ask(chrome.onClose as () => void) } : {}),
      ...(chrome.onBack ? { onBack: () => ask(chrome.onBack as () => void) } : {}),
    }),
  }
}

/** Why publishing refused a save, in its words: a draft its rules don't take. */
function publishRefusal(error: unknown): string | undefined {
  if (!isSixbApiError(error) || error.code !== "invalid_artifact") return undefined
  const said = (error.body as { error?: unknown } | null)?.error
  return typeof said === "string" ? said.replace(/^\[Sixb\] /, "") : undefined
}

/** Under the header, when a save didn't go through: why, and what the reader can do. */
function EditNotice({ edit }: { readonly edit: ArtifactEdit }) {
  const messages = useArtifactMessages().edit
  const user = useCurrentUser()
  const moved = edit.saving.state === "moved" ? edit.saving.latest : null
  const refused = edit.saving.state === "failed" ? edit.saving.refused : undefined
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[color-mix(in_oklab,var(--warning)_30%,var(--border))] bg-[color-mix(in_oklab,var(--warning)_9%,var(--background))] px-4 py-2.5 text-[13px]"
    >
      <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {moved
            ? messages.moved(
                moved.version,
                moved.author.type === "user" && moved.author.id === user?.id
              )
            : refused
              ? messages.saveRefused
              : messages.saveFailed}
        </p>
        {moved ? <p className="text-muted-foreground">{messages.movedDescription}</p> : null}
        {refused ? <p className="text-muted-foreground">{refused}</p> : null}
      </div>
      {moved ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={edit.openLatest}>
            {messages.openLatest(moved.version)}
          </Button>
          <Button size="sm" onClick={() => void edit.save(moved.version)}>
            {messages.saveAnyway(moved.version + 1)}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** Asks before a draft with changes is dropped: by Discard, or by closing the viewer. */
function DiscardDialog({ edit }: { readonly edit: ArtifactEdit }) {
  const messages = useArtifactMessages().edit
  return (
    <AlertDialog
      open={edit.confirming !== null}
      onOpenChange={(open) => {
        if (!open) edit.confirm(null)
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{messages.discardTitle}</AlertDialogTitle>
          <AlertDialogDescription>{messages.discardDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{messages.keepEditing}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              const then = edit.confirming
              edit.confirm(null)
              then?.()
            }}
          >
            {messages.discard}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * A renderer holds the reader's place in what it shows, so another artifact or version starts
 * afresh, and so does another part of a sheet or deck, which opens at its part. A document
 * scrolls to its part in place.
 */
function bodyKey(version: ArtifactVersion, kind: ArtifactKindName, part?: string): string {
  const at = `${version.artifactId}@${version.version}`
  return kind === "document" ? at : `${at}#${part ?? ""}`
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
  switch (kind) {
    case "document":
      return <DocumentRenderer version={version} latestVersion={latestVersion} part={part} />
    case "sheet":
      return <SheetRenderer version={version} part={part} />
    case "slides":
      return <SlidesRenderer version={version} part={part} />
    case "page":
      return <PageRenderer version={version} />
    case "canvas":
      return <CanvasRenderer version={version} {...(part ? { part } : {})} />
    case "file": {
      const source = versionFileSource(version, version.entry)
      return source ? (
        <FileRenderer source={source} />
      ) : (
        <ViewerNotice title={messages.viewer.loadFailed} />
      )
    }
  }
}

type ArtifactDetail = GetArtifactResponse

function ArtifactHeader({
  target,
  detail,
  version,
  chrome,
  edit,
  onVersionChange,
}: {
  readonly target: ArtifactTarget
  readonly detail: ArtifactDetail
  readonly version: ArtifactVersion
  readonly chrome: ViewerChrome
  readonly edit: ArtifactEdit
  readonly onVersionChange: (version: number) => void
}) {
  const messages = useArtifactMessages()
  const { artifact } = detail
  if (edit.editing) {
    // The draft bar: what is being edited, Discard, and Save as the next version.
    const saving = edit.saving.state === "saving"
    return (
      <ViewerBar
        chrome={chrome}
        leading={<ArtifactKindTile kind={artifact.kind} label={messages.kinds[artifact.kind]} />}
        title={version.title}
        accessory={
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-primary">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full bg-primary",
                edit.changed &&
                  "shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_22%,transparent)]"
              )}
            />
            {edit.changed ? messages.edit.unsaved : messages.edit.editing(version.version)}
          </span>
        }
      >
        <div className="flex items-center gap-1.5 pr-1">
          <div className="mr-1 flex items-center">
            <HeaderButton
              label={messages.edit.undo}
              onClick={edit.undo}
              disabled={!edit.undo || saving}
            >
              <Undo2 />
            </HeaderButton>
            <HeaderButton
              label={messages.edit.redo}
              onClick={edit.redo}
              disabled={!edit.redo || saving}
            >
              <Redo2 />
            </HeaderButton>
          </div>
          <Button size="sm" variant="ghost" onClick={edit.discard} disabled={saving}>
            {messages.edit.discard}
          </Button>
          <Button
            size="sm"
            onClick={() => void edit.save()}
            disabled={!edit.changed || saving}
            aria-keyshortcuts="Meta+S Control+S"
          >
            {saving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {saving ? messages.edit.saving : messages.edit.save(edit.next)}
          </Button>
        </div>
      </ViewerBar>
    )
  }
  return (
    <ViewerBar
      chrome={chrome}
      leading={<ArtifactKindTile kind={artifact.kind} label={messages.kinds[artifact.kind]} />}
      title={version.title}
      accessory={
        <VersionPicker detail={detail} version={version} onVersionChange={onVersionChange} />
      }
    >
      {edit.available ? (
        <Button
          size="sm"
          variant="ghost"
          className="mr-0.5 text-muted-foreground hover:text-foreground"
          onClick={edit.start}
        >
          <PencilLine aria-hidden="true" />
          {messages.edit.edit}
        </Button>
      ) : null}
      {artifact.kind === "sheet" ? (
        <SheetDownloadMenu version={version} />
      ) : (
        <EntryDownloadMenu version={version} kind={artifact.kind} />
      )}
      <CopyLinkButton link={() => artifactLink(target, artifact.latestVersion, location.origin)} />
    </ViewerBar>
  )
}

/**
 * The version shown, as a pill beside the title that opens every version with its date. An
 * earlier version than the latest carries a dot, so the reader knows there is a newer one.
 */
function VersionPicker({
  detail,
  version,
  onVersionChange,
}: {
  readonly detail: ArtifactDetail
  readonly version: ArtifactVersion
  readonly onVersionChange: (version: number) => void
}) {
  const messages = useArtifactMessages().viewer
  const locale = useLocale()
  const latest = detail.artifact.latestVersion
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${messages.versionLabel(version.version)} · ${messages.versions}`}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-border/80 bg-card pr-1.5 pl-2 text-xs font-medium text-muted-foreground tabular-nums shadow-[0_1px_1px_rgb(0_0_0/0.03)] outline-none transition-colors hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-border data-[state=open]:text-foreground"
      >
        {version.version === latest ? null : (
          <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
        )}
        {messages.version(version.version)}
        <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="max-h-80 w-64 p-1.5">
        <DropdownMenuLabel className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {messages.versions}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={String(version.version)}
          onValueChange={(value) => onVersionChange(Number(value))}
        >
          {detail.versions.map((entry) => (
            <DropdownMenuRadioItem
              key={entry.version}
              value={String(entry.version)}
              className="rounded-md py-1.5"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-medium tabular-nums">
                  {messages.versionLabel(entry.version)}
                </span>
                <span className="text-xs text-muted-foreground">{date(entry.createdAt)}</span>
              </span>
              {entry.version === latest ? (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                  {messages.latest}
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A sheet downloads as its workbook, built in the browser, or any of its sheets as CSV. */
function SheetDownloadMenu({ version }: { readonly version: ArtifactVersion }) {
  return <DownloadMenu options={useWorkbookDownloads(version, version.title)} />
}

/**
 * A document or a file downloads as its entry. A deck's or a page's entry is only its markup, no
 * file the reader wants on its own without the files beside it.
 */
function EntryDownloadMenu({
  version,
  kind,
}: {
  readonly version: ArtifactVersion
  readonly kind: ArtifactKindName
}) {
  const messages = useArtifactMessages()
  const locale = useLocale()
  const source =
    kind === "slides" || kind === "page" || kind === "canvas"
      ? null
      : versionFileSource(version, version.entry)
  if (!source) return null
  return (
    <DownloadMenu
      options={[
        {
          key: "entry",
          type: fileTypeOf(source.name),
          title: source.name,
          detail: formatFileSize(source.fileRef.sizeBytes, locale, messages.files),
          href: source.downloadUrl,
          fileName: source.name,
        },
      ]}
    />
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
  const name = useFileName(source)
  return (
    <ViewerBar
      chrome={chrome}
      leading={<FileTypeIcon type={fileTypeOf(name)} height={24} />}
      title={name}
      accessory={
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatFileSize(source.fileRef.sizeBytes, locale, messages.files)}
        </span>
      }
    >
      <HeaderLink
        href={source.inlineUrl}
        target="_blank"
        label={messages.viewer.openInNewTab(name)}
      >
        <ArrowUpRight />
      </HeaderLink>
      <HeaderLink href={source.downloadUrl} download={name} label={messages.viewer.download(name)}>
        <ArrowDownToLine />
      </HeaderLink>
    </ViewerBar>
  )
}

/**
 * The header, on one line: back on the full page, what the artifact is, its title, and its version,
 * then its actions, full page, and close.
 */
function ViewerBar({
  chrome,
  leading,
  title,
  accessory,
  children,
}: {
  readonly chrome: ViewerChrome
  /** What leads the title: an artifact's kind, or a file's type. */
  readonly leading?: ReactNode
  readonly title?: string
  /** What follows the title: an artifact's version, or a file's size. */
  readonly accessory?: ReactNode
  readonly children?: ReactNode
}) {
  const messages = useArtifactMessages().viewer
  return (
    <TooltipProvider delayDuration={400}>
      <header className="@container flex h-13 shrink-0 items-center gap-2 border-b border-border/60 px-2.5">
        {chrome.onBack ? (
          <HeaderButton label={messages.back} onClick={chrome.onBack}>
            <ArrowLeft />
          </HeaderButton>
        ) : null}
        <div className={cn("flex min-w-0 flex-1 items-center gap-2.5", !chrome.onBack && "pl-1")}>
          {leading}
          {title ? (
            <h2
              className="min-w-0 truncate text-[14.5px] leading-tight font-semibold tracking-[-0.01em] text-foreground"
              title={title}
            >
              {title}
            </h2>
          ) : null}
          {accessory}
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
  disabled = false,
  children,
}: {
  readonly label: string
  readonly onClick?: (() => void) | undefined
  readonly disabled?: boolean
  readonly children: ReactNode
}) {
  return (
    <HeaderTooltip label={label}>
      <button
        type="button"
        className={cn(HEADER_ACTION, "disabled:pointer-events-none disabled:opacity-35")}
        onClick={onClick}
        aria-label={label}
        disabled={disabled}
      >
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
  const { copied, copy } = useCopyFeedback()
  const label = copied ? messages.linkCopied : messages.copyLink
  return (
    <HeaderButton
      label={label}
      onClick={() => {
        copy(link())
      }}
    >
      {copied ? <Check /> : <Link2 />}
    </HeaderButton>
  )
}
