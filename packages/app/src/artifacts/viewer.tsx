import { deleteArtifact, type GetArtifactResponse, isSixbApiError } from "@sixb/client"
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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
  MoreHorizontal,
  PencilLine,
  Redo2,
  RefreshCw,
  RotateCcw,
  Trash2,
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
import { resetPageState, usePageStateCount } from "./page-state"
import { type ArtifactAuthor, useArtifactPeople } from "./people"
import { PersonAvatar } from "./person-avatar"
import { type ArtifactMoved, ArtifactMovedError } from "./publish-edit"
import { type ArtifactVersion, holdsQueries, useVersionQueries, versionFileSource } from "./queries"
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
  /** No link to the artifact's own page to copy: its reader cannot open it there. */
  readonly withoutPageLink?: boolean
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

  // While the reader edits, the view stays on the version edited: one published meanwhile is
  // announced over the draft, never opened under it.
  const editedVersion = useState<number | null>(null)
  const versionNumber = editedVersion[0] ?? target.version ?? detail?.artifact.latestVersion

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
  const edit = useArtifactEdit(target, detail, versionQuery.data, onTargetChange, editedVersion)
  const guarded = edit.guard(chrome)

  if (error || (artifactQuery.isSuccess && !detail)) {
    return (
      <>
        <ViewerBar chrome={chrome} />
        <LoadFailure error={error} />
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
      {edit.savedShared ? <SavedSharedNotice /> : null}
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

/**
 * Why the artifact can't be shown: it isn't shared with the reader, it no longer exists, or
 * reading it failed.
 */
function LoadFailure({ error }: { readonly error: unknown }) {
  const messages = useArtifactMessages().viewer
  const refusal = isSixbApiError(error) ? error : null

  if (refusal?.code === "not_shared") {
    return <ViewerNotice title={messages.notShared} description={messages.notSharedDescription} />
  }

  if (refusal?.status === 404) {
    return <ViewerNotice title={messages.notFound} description={messages.notFoundDescription} />
  }

  return (
    <ViewerNotice
      title={messages.loadFailed}
      {...(refusal?.status === 501 ? { description: messages.storageUnavailable } : {})}
    />
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
  /** A save just published to an artifact the reader shares through a conversation. */
  readonly savedShared: boolean
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
  onTargetChange: (target: ViewerTarget) => void,
  /** The version being edited, which the view holds to; null while not editing. */
  [edited, setEdited]: readonly [number | null, (version: number | null) => void]
): ArtifactEdit {
  const queries = useQueryClient()
  const editing = edited !== null
  const [draft, setDraft] = useState<ArtifactDraft | null>(null)
  const [state, setSaving] = useState<SaveState>({ state: "idle" })
  const [confirming, setConfirming] = useState<(() => void) | null>(null)
  const [savedShared, setSavedShared] = useState(false)
  const artifact = detail?.artifact
  // Its owner and the participants of a conversation that shares it publish; an observer reads.
  const canPublish = detail?.access === "owner" || detail?.access === "update"
  // A live sheet's rows are each reader's, read from its query: there is nothing in it to edit.
  const live =
    version?.outline.kind === "sheet" && version.outline.sheets.some((sheet) => sheet.query)
  const available =
    !!artifact &&
    !!version &&
    EDITABLE_KINDS.has(artifact.kind) &&
    version.version === artifact.latestVersion &&
    !live &&
    canPublish
  const changed = editing && !!draft?.changed

  // A version published while the reader edits is announced at once, as a save would meet it: with
  // the same choices, and the header's Save publishing over it.
  const arrived =
    editing && artifact && artifact.latestVersion > edited
      ? detail?.versions.find((entry) => entry.version === artifact.latestVersion)
      : undefined
  const saving: SaveState =
    arrived &&
    (state.state === "idle" ||
      state.state === "failed" ||
      (state.state === "moved" && state.latest.version < arrived.version))
      ? { state: "moved", latest: { version: arrived.version, author: arrived.author } }
      : state

  const stop = useCallback(() => {
    setEdited(null)
    setDraft(null)
    setSaving({ state: "idle" })
  }, [setEdited])

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
        // Someone else's artifact, saved through a conversation: say who sees the change.
        setSavedShared(detail?.access === "update")
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
    [version, draft, saving, queries, stop, onTargetChange, detail?.access]
  )

  // The confirmation says its piece and goes.
  useEffect(() => {
    if (!savedShared) return
    const timer = window.setTimeout(() => setSavedShared(false), 5_000)
    return () => window.clearTimeout(timer)
  }, [savedShared])

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
    savedShared,
    ...(editing && draft?.undo ? { undo: draft.undo } : {}),
    ...(editing && draft?.redo ? { redo: draft.redo } : {}),
    next: (saving.state === "moved" ? saving.latest.version : (artifact?.latestVersion ?? 0)) + 1,
    start: () => {
      if (!version) return
      setSaving({ state: "idle" })
      setEdited(version.version)
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

/** Under the header for a moment after a save that everyone in the conversation now sees. */
function SavedSharedNotice() {
  const messages = useArtifactMessages().edit
  return (
    <p
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2 text-[13px] text-muted-foreground animate-in fade-in-0 duration-200"
    >
      <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
      {messages.savedShared}
    </p>
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
  const live = holdsQueries(version)
  if (edit.editing) {
    // The draft bar: what is being edited, Discard, and Save as the next version. As the header
    // narrows, down to a phone's dialog, the state and Discard fold to icons, Save drops the
    // version, and the kind and full page give way, so Save and Close stay in view.
    const saving = edit.saving.state === "saving"
    const state = edit.changed ? messages.edit.unsaved : messages.edit.editing(version.version)
    const saveLabel = saving ? messages.edit.saving : messages.edit.save(edit.next)
    return (
      <ViewerBar
        chrome={chrome}
        editing
        leading={
          <span className="hidden @md:contents">
            <ArtifactKindTile kind={artifact.kind} label={messages.kinds[artifact.kind]} />
          </span>
        }
        title={version.title}
        accessory={
          <span
            title={state}
            className="hidden h-5 shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] px-[7px] py-0.5 text-xs font-medium whitespace-nowrap text-primary @xs:flex @3xl:px-2.5"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full bg-primary",
                edit.changed &&
                  "shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_22%,transparent)]"
              )}
            />
            <span className="sr-only @3xl:not-sr-only">{state}</span>
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
          <Button
            size="sm"
            variant="ghost"
            onClick={edit.discard}
            disabled={saving}
            aria-label={messages.edit.discard}
            title={messages.edit.discard}
            className="size-8 px-0 @lg:w-auto @lg:px-3"
          >
            {/* Wrapped, so the button keeps its padding when the label shows. */}
            <span className="contents @lg:hidden">
              <Trash2 aria-hidden="true" />
            </span>
            <span className="hidden @lg:inline">{messages.edit.discard}</span>
          </Button>
          <Button
            size="sm"
            onClick={() => void edit.save()}
            disabled={!edit.changed || saving}
            aria-keyshortcuts="Meta+S Control+S"
            aria-label={saveLabel}
          >
            {saving ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {saving ? null : <span className="@xl:hidden">{messages.edit.saveShort}</span>}
            <span className="hidden @xl:inline">{saveLabel}</span>
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
        <>
          <VersionPicker detail={detail} version={version} onVersionChange={onVersionChange} />
          {live ? <LiveStatus version={version} /> : null}
        </>
      }
    >
      {live ? <RefreshButton version={version} /> : null}
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
      <ArtifactMenu detail={detail} chrome={chrome} />
      {chrome.withoutPageLink ? null : (
        <CopyLinkButton
          link={() => artifactLink(target, artifact.latestVersion, location.origin)}
        />
      )}
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
      <DropdownMenuContent align="start" sideOffset={6} className="max-h-80 w-72 p-1.5">
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
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <VersionAuthor author={entry.author} />
                  <span className="shrink-0">{date(entry.createdAt)}</span>
                </span>
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

/**
 * Who published a version, when the reader can tell: themselves, or someone of the conversation the
 * artifact opens in.
 */
function VersionAuthor({ author }: { readonly author: ArtifactAuthor }) {
  const messages = useArtifactMessages().viewer
  const user = useCurrentUser()
  const nameOf = useArtifactPeople()
  const own = author.type === "user" && author.id === user?.id
  const name = own ? (user?.displayName ?? user?.email) : nameOf(author)
  if (!name) return null

  return (
    <>
      <PersonAvatar name={name} size="xs" />
      <span className="min-w-0 truncate">{own ? messages.you : name}</span>
      <span aria-hidden="true">·</span>
    </>
  )
}

/**
 * Says a version's data is live, and when the reader last read it, in their time zone: the time
 * alone on the day, the date with it after. A narrow header keeps its dot, the words in its title.
 */
function LiveStatus({ version }: { readonly version: ArtifactVersion }) {
  const messages = useArtifactMessages().viewer
  const locale = useLocale()
  const { readAt } = useVersionQueries(version)

  const read = readAt === null ? null : new Date(readAt)
  const sameDay = read?.toDateString() === new Date().toDateString()
  const time = read?.toLocaleString(locale, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  })
  const label = time ? messages.liveAt(time) : messages.live
  const detail = messages.liveDetail(
    read?.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
  )

  return (
    <span
      title={detail}
      data-live=""
      className="hidden h-5 shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--success)_10%,transparent)] px-[7px] py-0.5 text-xs font-medium whitespace-nowrap text-success tabular-nums @xs:flex @lg:px-2"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
      <span className="sr-only @lg:not-sr-only">{label}</span>
    </span>
  )
}

/** Reads every query of the version again, its icon turning while one is read. */
function RefreshButton({ version }: { readonly version: ArtifactVersion }) {
  const messages = useArtifactMessages().viewer
  const { refreshing, refresh } = useVersionQueries(version)
  return (
    <HeaderButton label={messages.refresh} onClick={refresh}>
      <RefreshCw className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
    </HeaderButton>
  )
}

/** A sheet downloads as its workbook, built in the browser, or any of its sheets as CSV. */
function SheetDownloadMenu({ version }: { readonly version: ArtifactVersion }) {
  return <DownloadMenu options={useWorkbookDownloads(version, version.title)} />
}

/**
 * The header's More: *Reset page data* once a page keeps something for the reader, and *Delete*
 * for the artifact's owner. An observer keeps nothing in a page and deletes nothing, so it has
 * neither. A reset that fails says so beside the button; a delete, in its confirmation.
 */
function ArtifactMenu({
  detail,
  chrome,
}: {
  readonly detail: ArtifactDetail
  readonly chrome: ViewerChrome
}) {
  const { viewer: messages, page } = useArtifactMessages()
  const queries = useQueryClient()
  const { artifact, access } = detail
  const count = usePageStateCount(artifact.id)
  const [reset, setReset] = useState<"idle" | "working" | "failed">("idle")
  const [deleting, setDeleting] = useState(false)

  const resettable =
    artifact.kind === "page" && access !== "read" && (count > 0 || reset === "working")
  const deletable = access === "owner"
  if (!resettable && !deletable) return null

  const resetData = async () => {
    setReset("working")
    try {
      await resetPageState(queries, artifact.id)
      setReset("idle")
    } catch (error) {
      console.warn("[SixbApp] Could not reset the page's data:", error)
      setReset("failed")
    }
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      {reset === "failed" ? (
        <span role="status" className="hidden text-xs text-destructive @lg:inline">
          {page.resetFailed}
        </span>
      ) : null}

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          aria-label={messages.more}
          title={messages.more}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground [&_svg]:size-[17px] [&_svg]:stroke-[1.75]"
        >
          {reset === "working" ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <MoreHorizontal aria-hidden="true" />
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={6} className="w-72 p-1.5">
          {resettable ? (
            <MenuAction
              icon={RotateCcw}
              title={page.reset}
              detail={page.resetDetail(count)}
              disabled={reset === "working"}
              onSelect={() => void resetData()}
            />
          ) : null}

          {resettable && deletable ? <DropdownMenuSeparator className="my-1" /> : null}

          {deletable ? (
            <MenuAction
              icon={Trash2}
              title={messages.delete}
              detail={messages.deleteDetail}
              destructive
              onSelect={() => setDeleting(true)}
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {deletable ? (
        <DeleteDialog
          artifact={artifact}
          chrome={chrome}
          open={deleting}
          onOpenChange={setDeleting}
        />
      ) : null}
    </span>
  )
}

/** An entry of the header's More: what it does, and a line on what that means. */
function MenuAction({
  icon: Icon,
  title,
  detail,
  destructive = false,
  disabled = false,
  onSelect,
}: {
  readonly icon: typeof Trash2
  readonly title: string
  readonly detail: string
  readonly destructive?: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
}) {
  return (
    <DropdownMenuItem
      className="items-start gap-3 rounded-md px-2 py-1.5"
      disabled={disabled}
      onSelect={onSelect}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          destructive ? "text-destructive" : "text-muted-foreground"
        )}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            "text-[13px] font-medium",
            destructive ? "text-destructive" : "text-foreground"
          )}
        >
          {title}
        </span>
        <span className="text-xs leading-snug text-muted-foreground">{detail}</span>
      </span>
    </DropdownMenuItem>
  )
}

/**
 * Asks before the owner deletes the artifact, which takes it from every conversation that shares
 * it. Deleted, the viewer closes, or goes back on the full page.
 */
function DeleteDialog({
  artifact,
  chrome,
  open,
  onOpenChange,
}: {
  readonly artifact: ArtifactDetail["artifact"]
  readonly chrome: ViewerChrome
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const messages = useArtifactMessages().viewer
  const queries = useQueryClient()
  const [state, setState] = useState<"idle" | "working" | "failed">("idle")

  const remove = async () => {
    setState("working")
    try {
      await deleteArtifact({ path: { artifactId: artifact.id }, throwOnError: true })
    } catch (error) {
      console.warn("[SixbApp] Could not delete the artifact:", error)
      setState("failed")
      return
    }

    onOpenChange(false)
    ;(chrome.onClose ?? chrome.onBack)?.()

    // Lists drop it; a viewer still on it reads that it is gone.
    void queries.invalidateQueries({
      predicate: (query) =>
        (query.queryKey[0] as { _id?: string } | undefined)?._id === "listArtifacts",
    })
    void queries.invalidateQueries({
      queryKey: getArtifactQueryKey({ path: { artifactId: artifact.id } }),
    })
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (state === "working") return
        setState("idle")
        onOpenChange(next)
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{messages.deleteTitle(artifact.title)}</AlertDialogTitle>
          <AlertDialogDescription>{messages.deleteDescription}</AlertDialogDescription>
        </AlertDialogHeader>

        {state === "failed" ? (
          <p role="alert" className="text-sm text-destructive">
            {messages.deleteFailed}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={state === "working"}>{messages.cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={state === "working"}
            onClick={(event) => {
              // It closes once the artifact is gone, not as the button is pressed.
              event.preventDefault()
              void remove()
            }}
          >
            {state === "working" ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : null}
            {state === "working" ? messages.deleting : messages.delete}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
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
  editing = false,
  leading,
  title,
  accessory,
  children,
}: {
  readonly chrome: ViewerChrome
  /** The draft bar: full page gives way to the draft's actions on a narrow header. */
  readonly editing?: boolean
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
            <HeaderLink
              to={chrome.fullPageHref}
              label={messages.openFullPage}
              {...(editing ? { className: "hidden @md:inline-flex" } : {})}
            >
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
  className,
  children,
}: {
  readonly label: string
  readonly to?: string
  readonly href?: string
  readonly download?: string
  readonly target?: "_blank"
  readonly className?: string
  readonly children: ReactNode
}) {
  return (
    <HeaderTooltip label={label}>
      {to ? (
        <Link to={to} className={cn(HEADER_ACTION, className)} aria-label={label}>
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
