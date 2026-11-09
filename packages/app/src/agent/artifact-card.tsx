import {
  getArtifactOptions,
  getArtifactRestorePointOptions,
  listArtifactRestorePointsOptions,
} from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import { versionChanges } from "../artifacts/card-details"
import { ArtifactCardFace, ArtifactLabel } from "../artifacts/card-preview"
import { ArtifactKindIcon } from "../artifacts/kind-icon"
import { useArtifactMessages } from "../artifacts/messages"
import { useArtifactVersion } from "../artifacts/queries"
import { artifactHref } from "../pages/routes"
import { useArtifactPanel } from "./artifact-panel"
import { useAgentMessages } from "./i18n"
import type { PublishedArtifact, TurnArtifact } from "./publish-artifact/interpret"

/**
 * What one response published, on the answer's reading path: a card for each artifact it created,
 * side by side, and a line for each one it revised, since its card is already in the conversation.
 * `runId` is the response's run, whose restore points say what it changed.
 */
export function ArtifactCards({
  artifacts,
  runId,
}: {
  readonly artifacts: readonly TurnArtifact[]
  readonly runId: string | null
}) {
  const messages = useAgentMessages().artifacts
  if (artifacts.length === 0) return null
  const created = artifacts.filter((artifact) => artifact.created)
  const revised = artifacts.filter((artifact) => !artifact.created)
  return (
    <div role="group" aria-label={messages.cards} className="flex flex-col gap-2.5">
      {created.length > 0 ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13.5rem),1fr))] gap-3">
          {created.map((artifact) => (
            <li key={artifact.artifactId} className="min-w-0">
              <ArtifactCard artifact={artifact} />
            </li>
          ))}
        </ul>
      ) : null}
      {revised.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {revised.map((artifact) => (
            <li key={artifact.artifactId} className="min-w-0">
              <ArtifactRevision artifact={artifact} runId={runId} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** A new artifact: a preview of it above its title, its kind, and what it holds. */
function ArtifactCard({ artifact }: { readonly artifact: PublishedArtifact }) {
  const selected = useIsOpen(artifact)
  const version = useVersion(artifact.artifactId, artifact.version)
  return (
    <OpenArtifact
      artifact={artifact}
      selected={selected}
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-2xl",
        !selected && "hover:shadow-[0_4px_14px_rgb(0_0_0/0.07)]"
      )}
    >
      <ArtifactCardFace
        kind={artifact.kind}
        title={artifact.title}
        version={version.data}
        loading={version.isLoading}
      />
    </OpenArtifact>
  )
}

/**
 * An artifact this response revised, and what it changed: its structure before the response, as
 * its restore point keeps it, against its structure after. A response from before restore points
 * published a version, compared with the one before it.
 */
function ArtifactRevision({
  artifact,
  runId,
}: {
  readonly artifact: PublishedArtifact
  readonly runId: string | null
}) {
  const artifactMessages = useArtifactMessages()
  const messages = useAgentMessages().artifacts
  const selected = useIsOpen(artifact)
  const change = useTurnChange(artifact, runId)
  const changes =
    change.before && change.after
      ? versionChanges(change.before, change.after, artifactMessages)
      : []
  return (
    <OpenArtifact
      artifact={artifact}
      selected={selected}
      className="flex w-full max-w-md items-center gap-3 rounded-xl py-2 pr-3 pl-2"
    >
      <ArtifactLabel
        title={artifact.title}
        detail={
          artifact.open === undefined
            ? [artifactMessages.viewer.versionLabel(artifact.version), ...changes.slice(0, 2)].join(
                " · "
              )
            : changes.length > 0
              ? changes.slice(0, 2).join(" · ")
              : messages.changed
        }
        icon={
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <ArtifactKindIcon kind={artifact.kind} className="size-4" />
          </span>
        }
        className="flex-1 gap-3"
      />
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </OpenArtifact>
  )
}

/**
 * The control around a card or line: it opens the artifact beside the conversation, or closes it
 * when it is the one open. Outside a conversation it links to the artifact's page.
 */
function OpenArtifact({
  artifact,
  selected,
  className,
  children,
}: {
  readonly artifact: PublishedArtifact
  readonly selected: boolean
  readonly className: string
  readonly children: ReactNode
}) {
  const panel = useArtifactPanel()
  const messages = useAgentMessages().artifacts
  const classes = cn(
    "group border bg-card text-left outline-none transition-[border-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    selected
      ? "border-foreground shadow-[0_0_0_0.5px_var(--foreground)]"
      : "border-border/80 shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:border-foreground/20",
    className
  )
  if (!panel) {
    return (
      <a
        href={artifactHref(artifact.artifactId, { version: artifact.version })}
        className={classes}
        aria-label={messages.open(artifact.title)}
      >
        {children}
      </a>
    )
  }
  return (
    <button
      type="button"
      className={classes}
      onClick={() =>
        selected
          ? panel.close()
          : panel.open({
              type: "artifact",
              artifactId: artifact.artifactId,
              version: artifact.version,
            })
      }
      aria-label={messages.open(artifact.title)}
      aria-pressed={selected}
    >
      {children}
    </button>
  )
}

/** A version of an artifact, read again while it is open and changes. */
function useVersion(artifactId: string, version: number) {
  return useArtifactVersion(artifactId, version, { enabled: version >= 1 })
}

type Outlined = Parameters<typeof versionChanges>[0]

/**
 * What a response changed in an artifact: `before`, the restore point taken before its first
 * write, and `after`, the next one taken, before the turn that followed, else the version as it
 * is now. A response from before restore points published a version: the one before it is
 * `before`. Either is undefined until read, or when the restore point is gone, as the oldest are,
 * or the reader may not list them.
 */
function useTurnChange(
  artifact: PublishedArtifact,
  runId: string | null
): { readonly before?: Outlined; readonly after?: Outlined } {
  const { artifactId } = artifact
  const legacy = artifact.open === undefined

  const points = useQuery({
    ...listArtifactRestorePointsOptions({ path: { artifactId } }),
    enabled: !legacy && runId !== null,
    retry: false,
  })
  const list = points.data?.restorePoints ?? []
  // Newest first: the one after the turn's is the one before it in the list.
  const index = list.findIndex((point) => point.reason === "turn" && point.turnRunId === runId)
  const turn = index >= 0 ? list[index] : undefined
  const next = index > 0 ? list[index - 1] : undefined

  const before = useRestorePoint(artifactId, turn?.revision)
  const afterPoint = useRestorePoint(artifactId, next?.revision)
  const current = useVersion(artifactId, legacy || turn ? artifact.version : 0)
  const previous = useVersion(artifactId, legacy ? artifact.version - 1 : 0)

  if (legacy) return { before: previous.data, after: current.data }
  return { before: before.data, after: next ? afterPoint.data : current.data }
}

/** A restore point's content, which never changes; nothing when `revision` is undefined. */
function useRestorePoint(artifactId: string, revision: number | undefined) {
  return useQuery({
    ...getArtifactRestorePointOptions({ path: { artifactId, revision: String(revision ?? 0) } }),
    enabled: revision !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}

/**
 * Whether the panel shows this card's version: a card for an earlier version of the same artifact
 * is not the one open. The panel shows the latest version when it names none, and the viewer has
 * already read which that is.
 */
function useIsOpen(artifact: PublishedArtifact): boolean {
  const target = useArtifactPanel()?.openTarget
  const sameArtifact = target?.type === "artifact" && target.artifactId === artifact.artifactId
  const pinned = sameArtifact ? target.version : undefined
  const { data } = useQuery({
    ...getArtifactOptions({ path: { artifactId: artifact.artifactId } }),
    enabled: sameArtifact && pinned === undefined,
    retry: false,
  })
  if (!sameArtifact) return false
  return (pinned ?? data?.artifact.latestVersion) === artifact.version
}
