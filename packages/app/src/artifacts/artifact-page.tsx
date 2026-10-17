import { useParams, useSearchParams } from "react-router-dom"
import { type ArtifactTarget, artifactTargetFromSearch, withArtifactTarget } from "./target"
import { Viewer } from "./viewer"

/**
 * An artifact on its own page, at `/artifacts/:artifactId` with `?v=` and `?part=`. It belongs to
 * no section: whoever may read the artifact can open it, and a link to it works anywhere.
 */
export function ArtifactPage() {
  const { artifactId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  if (!artifactId) return null

  // The artifact is the path; the version and part are parameters.
  const params = new URLSearchParams(searchParams)
  params.set("artifact", artifactId)
  const target: ArtifactTarget = artifactTargetFromSearch(params) ?? {
    type: "artifact",
    artifactId,
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <Viewer
        target={target}
        onTargetChange={(next) => {
          if (next.type !== "artifact") return
          const nextParams = withArtifactTarget(searchParams, next)
          nextParams.delete("artifact")
          setSearchParams(nextParams, { replace: true })
        }}
      />
    </div>
  )
}
