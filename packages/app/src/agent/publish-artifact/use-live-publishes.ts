import { getArtifactQueryKey } from "@sixb/client/hooks"
import { isMobileViewport } from "@sixb/ui/hooks"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { useArtifactPanel } from "../artifact-panel"
import type { NormalizedPart } from "../parts"
import { turnArtifacts } from "./interpret"

/** Runs that already opened an artifact in this tab, so a remount does not open it again. */
const openedRuns = new Set<string>()

/**
 * Follows what a live turn publishes: each new version refreshes the artifact and every list of
 * artifacts, and the turn's first publish opens the panel on it, at its latest version so later
 * versions of the turn replace it in place. It opens only beside the conversation or over the app:
 * a dialog would take the reader's focus, and the composer's, while the Agent is still working,
 * so there the card waits to be opened.
 */
export function useLivePublishes(live: {
  readonly runId: string | null
  readonly parts: readonly NormalizedPart[]
}): void {
  const panel = useArtifactPanel()
  const queryClient = useQueryClient()
  const seen = useRef(new Set<string>())

  useEffect(() => {
    const published = turnArtifacts(live.parts)
    let changed = false
    for (const artifact of published) {
      const key = `${artifact.artifactId}@${artifact.version}`
      if (seen.current.has(key)) continue
      seen.current.add(key)
      changed = true
      void queryClient.invalidateQueries({
        queryKey: getArtifactQueryKey({ path: { artifactId: artifact.artifactId } }),
      })
    }
    if (changed) void queryClient.invalidateQueries({ queryKey: [{ _id: "listArtifacts" }] })

    const first = published[0]
    if (!first || !panel || !live.runId || openedRuns.has(live.runId)) return
    openedRuns.add(live.runId)
    // On a phone's first render the panel has not learned the width yet, so the width is asked.
    if (panel.presentation === "dialog" || isMobileViewport()) return
    panel.open({ type: "artifact", artifactId: first.artifactId })
  }, [live.parts, live.runId, panel, queryClient])
}
