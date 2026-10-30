import { FileUp } from "lucide-react"
import { useArtifactMessages } from "../../artifacts/messages"
import { ActivityStatusText } from "../components/activity-status"
import { useAgentMessages } from "../i18n"
import type { NormalizedTool } from "../parts"
import { publishedArtifact, publishTitle } from "./interpret"

/**
 * A publish in the work trace: what it published and at which version, with any warnings, or why
 * it was refused. The answer's cards show the result; this row keeps each attempt.
 */
export function PublishArtifactToolView({ tool }: { tool: NormalizedTool }) {
  const messages = useAgentMessages().artifacts
  const versionLabel = useArtifactMessages().viewer.version
  const title = publishTitle(tool)
  const published = publishedArtifact(tool)
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const failed = tool.state === "output-error"
  const label = failed
    ? messages.publishFailed(title)
    : running
      ? messages.publishing(title)
      : messages.published(title)

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground">
        <FileUp className="size-3.5 shrink-0" />
        {running ? (
          <ActivityStatusText label={label} className="font-medium shimmer" />
        ) : (
          <span className="min-w-0 truncate font-medium">{label}</span>
        )}
        {published ? (
          <span className="shrink-0 text-muted-foreground/60 tabular-nums">
            · {versionLabel(published.version)}
          </span>
        ) : null}
      </div>
      {failed && tool.errorText ? (
        <p className="pl-5 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground/80">
          {refusal(tool.errorText)}
        </p>
      ) : null}
      {published && published.warnings.length > 0 ? (
        <ul className="space-y-0.5 pl-5 text-xs leading-relaxed text-muted-foreground/80">
          {published.warnings.map((warning, index) => (
            <li key={index}>
              {warning.part ? `${warning.part}: ` : ""}
              {warning.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** The refusal the Agent received, without the harness's prefix. */
function refusal(errorText: string): string {
  // [SixbAgentWorker] on refusals recorded before the harness had a package of its own.
  return errorText.replace(/^\[SixbAgent(?:Worker)?\] publish_artifact(_version)? refused: /, "")
}
