import { getArtifactOptions } from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { useArtifactMessages } from "../artifacts/messages"
import { ArtifactThumbnail } from "../artifacts/thumbnail"
import { artifactHref } from "../pages/routes"
import { useArtifactPanel } from "./artifact-panel"
import { useAgentMessages } from "./i18n"
import type { PublishedArtifact } from "./publish-artifact/interpret"

/** What one response published: a card per artifact, in one row on the answer's reading path. */
export function ArtifactCards({ artifacts }: { readonly artifacts: readonly PublishedArtifact[] }) {
  const messages = useAgentMessages().artifacts
  if (artifacts.length === 0) return null
  return (
    <ul aria-label={messages.cards} className="flex flex-wrap gap-2.5">
      {artifacts.map((artifact) => (
        <li key={artifact.artifactId} className="max-w-full">
          <ArtifactCard artifact={artifact} />
        </li>
      ))}
    </ul>
  )
}

/** One artifact at the version the response published: its miniature, title, and kind. */
function ArtifactCard({ artifact }: { readonly artifact: PublishedArtifact }) {
  const panel = useArtifactPanel()
  const messages = useAgentMessages().artifacts
  const artifactMessages = useArtifactMessages()
  const selected = useIsOpen(artifact)
  const className = cn(
    "group flex w-[22rem] max-w-full items-center gap-3.5 rounded-2xl border bg-card p-2 pr-4 text-left outline-none transition-[border-color,box-shadow,background-color] duration-200 focus-visible:ring-2 focus-visible:ring-ring",
    selected
      ? "border-foreground/20 bg-muted/60"
      : "border-border/70 shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:border-foreground/15 hover:shadow-[0_2px_8px_rgb(0_0_0/0.06)]"
  )
  const content = (
    <>
      <ArtifactThumbnail
        artifactId={artifact.artifactId}
        version={artifact.version}
        kind={artifact.kind}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className="line-clamp-2 text-[14px] leading-snug font-medium text-foreground"
          title={artifact.title}
        >
          {artifact.title}
        </span>
        <span className="text-[12.5px] text-muted-foreground tabular-nums">
          {artifactMessages.kinds[artifact.kind]} ·{" "}
          {artifactMessages.viewer.versionLabel(artifact.version)}
        </span>
      </span>
    </>
  )

  if (!panel) {
    return (
      <a
        href={artifactHref(artifact.artifactId, { version: artifact.version })}
        className={className}
        aria-label={messages.open(artifact.title)}
      >
        {content}
      </a>
    )
  }
  return (
    <button
      type="button"
      className={className}
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
      {content}
    </button>
  )
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
