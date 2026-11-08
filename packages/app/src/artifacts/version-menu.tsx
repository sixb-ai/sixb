import {
  freezeArtifactVersion,
  type GetArtifactResponse,
  type ListArtifactRestorePointsResponse,
  restoreArtifact,
} from "@sixb/client"
import {
  getArtifactRestorePointOptions,
  listArtifactRestorePointsOptions,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, History, LoaderCircle, Milestone } from "lucide-react"
import { useEffect, useState } from "react"
import { useCurrentUser } from "../session"
import { versionChanges } from "./card-details"
import { useArtifactMessages } from "./messages"
import { type ArtifactAuthor, useArtifactPeople } from "./people"
import { PersonAvatar } from "./person-avatar"
import { movedTo } from "./publish-edit"
import { type ArtifactVersion, artifactChanged } from "./queries"

type ArtifactDetail = GetArtifactResponse
type VersionEntry = ArtifactDetail["versions"][number]
type RestorePoint = ListArtifactRestorePointsResponse["restorePoints"][number]

/**
 * The version shown, as a pill beside the title: "Current" while it is the open version, which
 * changes in place, else its number. It opens every version with who last wrote or created it, and
 * for whoever may change the artifact, *Create version*, which freezes the current one, and the
 * restore points kept before the Agent's turns and before restores, each restored once confirmed. An earlier
 * version than the latest carries a dot, so the reader knows there is a newer one.
 */
export function VersionMenu({
  detail,
  version,
  onVersionChange,
  onRestored,
}: {
  readonly detail: ArtifactDetail
  readonly version: ArtifactVersion
  readonly onVersionChange: (version: number) => void
  /** The artifact holds a restore point's content again: the view goes to its latest. */
  readonly onRestored: () => void
}) {
  const messages = useArtifactMessages()
  const queries = useQueryClient()
  const { artifact, access } = detail
  const latest = detail.versions.find((entry) => entry.version === artifact.latestVersion)
  const canChange = access === "owner" || access === "update"
  const [open, setOpen] = useState(false)
  const [restoring, setRestoring] = useState<RestorePoint | null>(null)
  const [status, setStatus] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null
  )

  // A confirmation says its piece and goes; a failure stays until the next try.
  useEffect(() => {
    if (!status || status.failed) return
    const timer = window.setTimeout(() => setStatus(null), 4_000)
    return () => window.clearTimeout(timer)
  }, [status])

  const points = useQuery({
    ...listArtifactRestorePointsOptions({ path: { artifactId: artifact.id } }),
    enabled: open && canChange,
    retry: false,
  })

  const create = async () => {
    try {
      const { data } = await freezeArtifactVersion({
        path: { artifactId: artifact.id },
        body: { baseRevision: artifact.revision },
        throwOnError: true,
      })
      setStatus({ text: messages.versions.createdStatus(data.version.version), failed: false })
    } catch (error) {
      // What changed since is read again: the menu then shows what there is to create.
      if (!movedTo(error)) console.warn("[SixbApp] Could not create a version:", error)
      setStatus({ text: messages.versions.createFailed, failed: true })
    }
    artifactChanged(queries, artifact.id)
  }

  const label = version.frozen
    ? messages.viewer.version(version.version)
    : messages.versions.current

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          aria-label={`${version.frozen ? messages.viewer.versionLabel(version.version) : label} · ${messages.viewer.versions}`}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-border/80 bg-card pr-1.5 pl-2 text-xs font-medium text-muted-foreground tabular-nums shadow-[0_1px_1px_rgb(0_0_0/0.03)] outline-none transition-colors hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-border data-[state=open]:text-foreground"
        >
          {version.version === artifact.latestVersion ? null : (
            <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
          )}
          {label}
          <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-[min(18rem,calc(100vw-2rem))] p-1.5"
        >
          <DropdownMenuLabel className="px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {messages.viewer.versions}
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
                <VersionLine entry={entry} />
                {entry.frozen && entry.version === artifact.latestVersion ? (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                    {messages.versions.latest}
                  </span>
                ) : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          {canChange ? (
            <>
              <DropdownMenuSeparator className="my-1" />

              <DropdownMenuItem
                className="items-start gap-3 rounded-md px-2 py-1.5"
                disabled={!latest || latest.frozen}
                onSelect={() => void create()}
              >
                <Milestone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-foreground">
                    {messages.versions.create}
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {latest?.frozen
                      ? messages.versions.unchanged(latest.version)
                      : messages.versions.createDetail(artifact.latestVersion)}
                  </span>
                </span>
              </DropdownMenuItem>

              {/* In the menu itself, not a submenu: one opening beside it leaves a phone's screen. */}
              <DropdownMenuSeparator className="my-1" />
              <DropdownMenuLabel className="flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                <History className="size-3.5" aria-hidden="true" />
                {messages.versions.restore}
              </DropdownMenuLabel>
              <DropdownMenuGroup aria-label={messages.versions.restore}>
                <RestorePoints
                  points={points.data?.restorePoints}
                  loading={points.isLoading}
                  onSelect={setRestoring}
                />
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {status ? (
        <span
          role="status"
          className={cn(
            "hidden shrink-0 text-xs @md:inline",
            status.failed ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {status.text}
        </span>
      ) : null}

      <RestoreDialog
        detail={detail}
        current={version.version === artifact.latestVersion ? version : null}
        point={restoring}
        onClose={() => setRestoring(null)}
        onRestored={onRestored}
      />
    </>
  )
}

/**
 * One version of the menu: the current one with who last wrote it and when, a created one with who
 * created it and when.
 */
function VersionLine({ entry }: { readonly entry: VersionEntry }) {
  const messages = useArtifactMessages()
  const when = useWhen()
  const who = useWho()

  const writer = entry.frozen ? (entry.frozenBy ?? entry.author) : entry.author
  const name = who(writer, entry.frozen ? undefined : entry.origin)
  const line = entry.frozen
    ? messages.versions.createdBy(name?.text ?? null, when(entry.frozenAt ?? entry.updatedAt))
    : messages.versions.edited(name?.text ?? null, when(entry.updatedAt))

  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="text-[13px] font-medium tabular-nums">
        {entry.frozen ? messages.viewer.versionLabel(entry.version) : messages.versions.current}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {name?.avatar ? <PersonAvatar name={name.avatar} size="xs" /> : null}
        <span className="min-w-0 truncate">{line}</span>
      </span>
    </span>
  )
}

/** The restore points, newest first, each by what it was kept before and when. */
function RestorePoints({
  points,
  loading,
  onSelect,
}: {
  readonly points: readonly RestorePoint[] | undefined
  readonly loading: boolean
  readonly onSelect: (point: RestorePoint) => void
}) {
  const messages = useArtifactMessages().versions
  const when = useWhen()

  if (!points || points.length === 0) {
    return (
      <DropdownMenuItem disabled className="rounded-md px-2 py-1.5 text-[13px]">
        {loading ? messages.restorePointsLoading : messages.noRestorePoints}
      </DropdownMenuItem>
    )
  }

  return points.map((point) => (
    <DropdownMenuItem
      key={point.revision}
      className="flex-col items-start gap-0.5 rounded-md px-2 py-1.5"
      onSelect={() => onSelect(point)}
    >
      <span className="text-[13px] font-medium text-foreground">
        {messages.restorePoint(point.reason)}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">{when(point.createdAt)}</span>
    </DropdownMenuItem>
  ))
}

/**
 * Asks before a restore point's content goes back in the artifact: what it held, who left it so,
 * and what restoring changes in its structure, against the latest version when it is the one
 * shown. It closes once restored; a change made meanwhile is refused, and said so.
 */
function RestoreDialog({
  detail,
  current,
  point,
  onClose,
  onRestored,
}: {
  readonly detail: ArtifactDetail
  readonly current: ArtifactVersion | null
  readonly point: RestorePoint | null
  readonly onClose: () => void
  readonly onRestored: () => void
}) {
  const all = useArtifactMessages()
  const messages = all.versions
  const queries = useQueryClient()
  const when = useWhen()
  const who = useWho()
  const [state, setState] = useState<"idle" | "working" | "failed" | "moved">("idle")
  const artifactId = detail.artifact.id

  const held = useQuery({
    ...getArtifactRestorePointOptions({
      path: { artifactId, revision: String(point?.revision ?? 0) },
    }),
    enabled: point !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const changes = current && held.data ? versionChanges(current, held.data, all) : []

  const restore = async () => {
    if (!point) return
    setState("working")
    try {
      await restoreArtifact({
        path: { artifactId, revision: String(point.revision) },
        body: { baseRevision: detail.artifact.revision },
        throwOnError: true,
      })
    } catch (error) {
      setState(movedTo(error) ? "moved" : "failed")
      artifactChanged(queries, artifactId)
      return
    }

    setState("idle")
    artifactChanged(queries, artifactId)
    onClose()
    onRestored()
  }

  const name = point ? who(point.author, point.origin) : null
  return (
    <AlertDialog
      open={point !== null}
      onOpenChange={(open) => {
        if (open || state === "working") return
        setState("idle")
        onClose()
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {point
              ? messages.restoreTitle(messages.restorePoint(point.reason), when(point.createdAt))
              : null}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {point ? messages.restoreHeld(point.title, name?.text ?? null) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {changes.length > 0 ? (
          <div className="text-sm text-muted-foreground">
            <p className="m-0">{messages.restoreChanges}</p>
            <ul className="m-0 mt-1 list-disc pl-5">
              {changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="m-0 text-sm text-muted-foreground">{messages.restoreUndo}</p>

        {state === "failed" || state === "moved" ? (
          <p role="alert" className="m-0 text-sm text-destructive">
            {state === "moved" ? messages.restoreMoved : messages.restoreFailed}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={state === "working"}>{messages.cancel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={state === "working"}
            onClick={(event) => {
              // It closes once restored, not as the button is pressed.
              event.preventDefault()
              void restore()
            }}
          >
            {state === "working" ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : null}
            {state === "working" ? messages.restoring : messages.restoreConfirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Who wrote or created something, as the reader can tell: "you", the Agent when its turn wrote it,
 * or someone of the conversation the artifact opens in. `avatar` is the name a picture is drawn
 * for; none for the Agent. Null when nobody can be named.
 */
function useWho(): (
  author: ArtifactAuthor,
  origin?: { readonly runId: string }
) => { readonly text: string; readonly avatar?: string } | null {
  const messages = useArtifactMessages().versions
  const user = useCurrentUser()
  const nameOf = useArtifactPeople()

  return (author, origin) => {
    if (origin) return { text: messages.agent }

    if (author.type === "user" && author.id === user?.id) {
      const own = user?.displayName ?? user?.email
      return { text: messages.you, ...(own ? { avatar: own } : {}) }
    }

    const name = nameOf(author)
    return name ? { text: name, avatar: name } : null
  }
}

/** A moment, as the reader reads it: the time alone today, the date with it before. */
function useWhen(): (iso: string) => string {
  const locale = useLocale()
  return (iso) => {
    const date = new Date(iso)
    const today = date.toDateString() === new Date().toDateString()
    return date.toLocaleString(locale, {
      ...(today ? {} : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    })
  }
}
