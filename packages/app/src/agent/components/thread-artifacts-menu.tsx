import { listArtifactsOptions } from "@sixb/client/hooks"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, Layers } from "lucide-react"
import { Link } from "react-router-dom"
import { ArtifactKindIcon } from "../../artifacts/kind-icon"
import { useArtifactMessages } from "../../artifacts/messages"
import { ARTIFACTS_HREF } from "../../pages/routes"
import { useArtifactPanel } from "../artifact-panel"
import { useAgentMessages } from "../i18n"

/**
 * The artifacts the Agent published in this conversation, each one opening in the panel, and the
 * way to every artifact in the gallery.
 */
export function ThreadArtifactsMenu({ threadId }: { readonly threadId: string }) {
  const panel = useArtifactPanel()
  const messages = useAgentMessages().artifacts
  const artifactMessages = useArtifactMessages()
  const { data } = useQuery({
    ...listArtifactsOptions({ query: { thread: threadId } }),
    retry: false,
  })
  const artifacts = data?.artifacts ?? []
  if (!panel || artifacts.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={messages.list(artifacts.length)}
          title={messages.list(artifacts.length)}
          className="gap-1.5 text-muted-foreground"
        >
          <Layers />
          <span className="tabular-nums">{artifacts.length}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>{messages.list(artifacts.length)}</DropdownMenuLabel>
        {artifacts.map((artifact) => (
          <DropdownMenuItem
            key={artifact.id}
            onSelect={() => panel.open({ type: "artifact", artifactId: artifact.id })}
            className="gap-2.5"
          >
            <ArtifactKindIcon kind={artifact.kind} className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {artifactMessages.kinds[artifact.kind]} ·{" "}
              {artifactMessages.viewer.version(artifact.latestVersion)}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="gap-2.5 text-muted-foreground">
          <Link to={ARTIFACTS_HREF}>
            <Layers className="size-4" />
            <span className="flex-1">{messages.all}</span>
            <ArrowUpRight className="size-3.5" />
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
