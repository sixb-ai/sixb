import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react"
import { type LiveArtifact, type LiveArtifactState, LiveHub } from "./session"

let pageHub: LiveHub | null = null

const LiveHubContext = createContext<LiveHub | null>(null)

/** The hub views hold live artifacts through: one per page, unless a test provides its own. */
export function LiveHubProvider({
  hub,
  children,
}: {
  readonly hub: LiveHub
  readonly children: ReactNode
}) {
  return createElement(LiveHubContext.Provider, { value: hub }, children)
}

function useLiveHub(): LiveHub {
  const provided = useContext(LiveHubContext)
  if (provided) return provided
  pageHub ??= new LiveHub()
  return pageHub
}

/**
 * Holds an artifact live while the view does: its document and presence, kept in step with
 * everyone else's. Null while `artifactId` is, as for a version that is not the latest.
 */
export function useLiveArtifact(artifactId: string | null): LiveArtifact | null {
  const hub = useLiveHub()
  const [artifact, setArtifact] = useState<LiveArtifact | null>(null)

  useEffect(() => {
    if (!artifactId) {
      setArtifact(null)
      return
    }

    const held = hub.acquire(artifactId)
    setArtifact(held)
    return () => {
      hub.release(held)
    }
  }, [hub, artifactId])

  return artifactId && artifact?.artifactId === artifactId ? artifact : null
}

const NOT_LIVE: LiveArtifactState = {
  connection: "connecting",
  access: null,
  synced: false,
  save: null,
  pending: false,
  user: null,
  left: null,
}

const noSubscription = () => () => {}

/** What the server says of a live artifact, as it changes. */
export function useLiveArtifactState(artifact: LiveArtifact | null): LiveArtifactState {
  return useSyncExternalStore(
    artifact?.subscribe ?? noSubscription,
    artifact?.getState ?? (() => NOT_LIVE),
    () => NOT_LIVE
  )
}

const LiveArtifactContext = createContext<LiveArtifact | null>(null)

/** The artifact the viewer holds live, for the renderer under it. */
export function LiveArtifactProvider({
  artifact,
  children,
}: {
  readonly artifact: LiveArtifact | null
  readonly children: ReactNode
}) {
  return createElement(LiveArtifactContext.Provider, { value: artifact }, children)
}

export function useViewerLiveArtifact(): LiveArtifact | null {
  return useContext(LiveArtifactContext)
}
