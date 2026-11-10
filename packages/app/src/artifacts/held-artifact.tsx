import { isSixbApiError } from "@sixb/client"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { FileX, Lock, RotateCcw, TriangleAlert } from "lucide-react"
import { Link } from "react-router-dom"
import { artifactHref } from "../pages/routes"
import { ArtifactCardFace } from "./card-preview"
import { ArtifactKindIcon } from "./kind-icon"
import { useArtifactMessages } from "./messages"
import { artifactVersionOptions, useArtifactUpdates } from "./queries"

/**
 * Artifacts an object holds in a property, as its page shows them: each one a card with a preview of
 * its latest version that opens it. One card or many, they line up as a conversation's cards do.
 */
export function HeldArtifactCards({ artifactIds }: { readonly artifactIds: readonly string[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-3">
      {artifactIds.map((artifactId, index) => (
        // The same artifact can be held twice in a list.
        <li key={`${artifactId}:${index}`} className="min-w-0">
          <HeldArtifactCard artifactId={artifactId} />
        </li>
      ))}
    </ul>
  )
}

const CARD_CLASS_NAME =
  "flex w-full flex-col overflow-hidden rounded-xl border bg-card text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)]"

/**
 * One held artifact, followed live: what someone saves or the Agent writes shows on the card as it
 * happens. One that is gone, or that the reader cannot open, is a quiet line that says so.
 */
function HeldArtifactCard({ artifactId }: { readonly artifactId: string }) {
  const messages = useArtifactMessages().held
  const query = useQuery(artifactVersionOptions(artifactId, "latest"))
  useArtifactUpdates(artifactId)

  // A read again that fails keeps what was read, unless the artifact is gone for the reader.
  const version = query.data
  const problem = query.error ? heldArtifactProblem(query.error) : null
  const gone = problem === "gone" || problem === "notShared"

  if (version && !gone) {
    return (
      <Link
        to={artifactHref(artifactId)}
        aria-label={messages.open(version.title)}
        className={cn(
          CARD_CLASS_NAME,
          "group border-border/80 outline-none transition-[border-color,box-shadow] duration-200 hover:border-foreground/20 hover:shadow-[0_4px_14px_rgb(0_0_0/0.07)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        )}
      >
        <ArtifactCardFace
          kind={version.outline.kind}
          title={version.title}
          version={version}
          loading={false}
        />
      </Link>
    )
  }

  if (query.isPending) return <HeldArtifactSkeleton label={messages.loading} />

  return <UnavailableCard problem={problem ?? "failed"} onRetry={() => void query.refetch()} />
}

/** Why a held artifact cannot be shown: it is gone, it is not the reader's to open, or reading it failed. */
export type HeldArtifactProblem = "gone" | "notShared" | "failed" | "storageUnavailable"

export function heldArtifactProblem(error: unknown): HeldArtifactProblem {
  if (!isSixbApiError(error)) return "failed"
  if (error.code === "not_shared" || error.status === 403) return "notShared"
  if (error.status === 404) return "gone"
  // Trying again cannot help until the server is given artifact storage.
  if (error.status === 501) return "storageUnavailable"
  return "failed"
}

/** The card's shape while the artifact loads, so the page does not move when it arrives. */
function HeldArtifactSkeleton({ label }: { readonly label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(CARD_CLASS_NAME, "border-border/60 shadow-none")}
    >
      <span className="block h-[7.75rem] animate-pulse border-b border-border/60 bg-muted/50 motion-reduce:animate-none" />
      <span className="flex items-center gap-2.5 px-3.5 py-3">
        <span className="size-4 shrink-0 rounded bg-muted" />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="h-3 w-2/3 rounded bg-muted" />
          <span className="h-2.5 w-1/3 rounded bg-muted/70" />
        </span>
      </span>
    </div>
  )
}

const PROBLEM_ICONS = {
  gone: FileX,
  notShared: Lock,
  failed: TriangleAlert,
  storageUnavailable: TriangleAlert,
} as const

/**
 * A quiet line in the place of a card the reader cannot open, saying why in their words, never
 * with an id: nothing is there to preview.
 */
function UnavailableCard({
  problem,
  onRetry,
}: {
  readonly problem: HeldArtifactProblem
  readonly onRetry: () => void
}) {
  const messages = useArtifactMessages()
  const held = messages.held
  const Icon = PROBLEM_ICONS[problem]

  const [title, description] =
    problem === "gone"
      ? [held.gone, held.goneDescription]
      : problem === "notShared"
        ? [held.notShared, held.notSharedDescription]
        : [
            held.loadFailed,
            problem === "storageUnavailable" ? messages.viewer.storageUnavailable : "",
          ]

  return (
    <div className={cn(CARD_CLASS_NAME, "border-dashed border-border bg-muted/20 shadow-none")}>
      <span className="flex min-h-[3.75rem] items-center gap-3 px-3.5 py-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border/70"
        >
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] leading-snug font-medium text-foreground">
            {title}
          </span>
          {description ? (
            <span className="text-[12px] leading-snug text-muted-foreground">{description}</span>
          ) : null}
        </span>
        {problem === "failed" ? (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {held.retry}
          </button>
        ) : null}
      </span>
    </div>
  )
}

/**
 * A held artifact where a value is a line among others, such as a run's input: its kind and title,
 * opening it. Without `link`, it names the artifact without sending its reader there.
 */
export function HeldArtifactChip({
  artifactId,
  link = true,
}: {
  readonly artifactId: string
  readonly link?: boolean
}) {
  const messages = useArtifactMessages().held
  const query = useQuery(artifactVersionOptions(artifactId, "latest"))
  const version = query.data

  const chip =
    "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs font-medium"

  if (!version) {
    if (query.isPending) {
      return (
        <span role="status" aria-label={messages.loading} className={chip}>
          <span className="size-3 shrink-0 rounded-sm bg-muted-foreground/20" />
          <span className="h-2.5 w-20 animate-pulse rounded bg-muted-foreground/15 motion-reduce:animate-none" />
        </span>
      )
    }

    const problem = heldArtifactProblem(query.error)
    const Icon = PROBLEM_ICONS[problem]
    const label =
      problem === "gone"
        ? messages.gone
        : problem === "notShared"
          ? messages.notShared
          : messages.loadFailed
    return (
      <span className={cn(chip, "font-normal text-muted-foreground")}>
        <Icon className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    )
  }

  const content = (
    <>
      <ArtifactKindIcon
        kind={version.outline.kind}
        className="size-3 shrink-0 text-muted-foreground"
      />
      <span className="truncate">{version.title}</span>
    </>
  )

  if (!link) {
    return (
      <span className={chip} title={version.title}>
        {content}
      </span>
    )
  }

  return (
    <Link
      to={artifactHref(artifactId)}
      title={version.title}
      className={cn(
        chip,
        "outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      {content}
    </Link>
  )
}
