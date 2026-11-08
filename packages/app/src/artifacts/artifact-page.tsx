import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import {
  type ArtifactTarget,
  artifactTargetFromSearch,
  artifactTargetHref,
  withArtifactTarget,
} from "./target"
import { AgentDraftContext, keepAgentDraft } from "./view-context"
import { Viewer } from "./viewer"

/**
 * An artifact on its own page, at `/artifacts/:artifactId` with `?v=` and `?part=`: the whole
 * window, over whatever shell the app draws, so a shared link opens just the artifact. It belongs
 * to no section: whoever may read the artifact can open it, and a link to it works anywhere.
 */
export function ArtifactPage() {
  const { artifactId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  if (!artifactId) return null

  // The artifact is the path; the version and part are parameters.
  const params = new URLSearchParams(searchParams)
  params.set("artifact", artifactId)
  const target: ArtifactTarget = artifactTargetFromSearch(params) ?? {
    type: "artifact",
    artifactId,
  }

  // Asked of the Agent from here, words wait for the conversation at home, in its input.
  const draftForAgent = (text: string) => {
    keepAgentDraft(text)
    navigate("/")
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top,0px)] text-foreground">
      <AgentDraftContext.Provider value={draftForAgent}>
        <Viewer
          target={target}
          chrome={{
            // Back to where the link was followed from, or into the app for a link opened cold.
            onBack: () => (canGoBack() ? navigate(-1) : navigate("/")),
          }}
          // A version or part of this artifact replaces the address; it is the same page.
          onTargetChange={(next) => {
            if (next.type !== "artifact") return
            const nextParams = withArtifactTarget(searchParams, next)
            nextParams.delete("artifact")
            setSearchParams(nextParams, { replace: true })
          }}
          // Another artifact is another page, so back returns to this one.
          onOpenReference={(next) => navigate(artifactTargetHref(next))}
        />
      </AgentDraftContext.Provider>
    </div>
  )
}

/** React Router numbers the entries it pushed; the first one has nowhere in the app to go back to. */
function canGoBack(): boolean {
  const state: unknown = window.history.state
  return (
    typeof state === "object" &&
    state !== null &&
    "idx" in state &&
    typeof state.idx === "number" &&
    state.idx > 0
  )
}
