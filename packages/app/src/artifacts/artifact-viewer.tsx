import { isMobileViewport, useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { artifactHref } from "../pages/routes"
import { HeldArtifactCards } from "./held-artifact"
import { artifactTargetHref, type ViewerTarget } from "./target"
import { Viewer } from "./viewer"

export interface ArtifactViewerProps {
  /** The artifact to show, at its latest version: `object.properties.plan.id`. */
  readonly artifactId: string
  /** Sizes the frame; it is 34rem tall unless a class says otherwise. */
  readonly className?: string
}

/**
 * An artifact in place on a page of your own, such as the plan a contract holds: the viewer its
 * own page uses, under its header, following it live, with its versions and its comments. Open full
 * page, and an artifact it links to, go to that artifact's page.
 *
 * On a phone it is the artifact's card, opening its page: a canvas panned inside a page that
 * scrolls fights the finger, and the page gives the artifact the whole screen.
 */
export function ArtifactViewer({ artifactId, className }: ArtifactViewerProps) {
  const navigate = useNavigate()
  // Asked of the window too: the hook answers only after the first render, too late to keep a
  // phone from opening the live viewer.
  const mobile = useIsMobile() || isMobileViewport()
  const [target, setTarget] = useState<ViewerTarget>({ type: "artifact", artifactId })

  // Another artifact opens at its own latest version, not at the version or part the last one was.
  const [shown, setShown] = useState(artifactId)
  if (shown !== artifactId) {
    setShown(artifactId)
    setTarget({ type: "artifact", artifactId })
  }

  if (mobile) return <HeldArtifactCards artifactIds={[artifactId]} />

  return (
    <div
      className={cn(
        "flex h-[34rem] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background",
        className
      )}
    >
      <Viewer
        target={target}
        onTargetChange={setTarget}
        onOpenReference={(next) => navigate(artifactTargetHref(next))}
        chrome={{ fullPageHref: artifactHref(artifactId) }}
      />
    </div>
  )
}
