import type { SixbClient } from "@sixb/client"
import { useQueryClient } from "@tanstack/react-query"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  createWorkspaceClient,
  loadWorkspace,
  saveWorkspace,
  sessionStore,
  signOut,
  type Workspace,
} from "./workspace"

export type WorkspaceState =
  | { readonly status: "loading" }
  | {
      readonly status: "disconnected"
      /** The last workspace's address, to prefill the connect screen. */
      readonly address: string | null
      readonly notice: string | null
    }
  | { readonly status: "connected"; readonly workspace: Workspace; readonly client: SixbClient }

interface WorkspaceContextValue {
  readonly state: WorkspaceState
  /** Enter a workspace that answered the probe and, when it needs it, is signed in. */
  open(workspace: Workspace): Promise<void>
  /** Sign out of the current workspace and return to the connect screen. */
  leave(): Promise<void>
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceProvider({ children }: { readonly children: ReactNode }) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<WorkspaceState>({ status: "loading" })

  // The session was revoked or idled out: the client has already cleared its tokens. Keep the
  // workspace so the connect screen offers the same address again.
  const sessionEnded = useCallback(
    (workspace: Workspace) => {
      queryClient.clear()
      setState({
        status: "disconnected",
        address: workspace.baseUrl,
        notice: "Your session ended. Sign in again.",
      })
    },
    [queryClient]
  )

  const connect = useCallback(
    (workspace: Workspace) =>
      setState({
        status: "connected",
        workspace,
        client: createWorkspaceClient(workspace, () => sessionEnded(workspace)),
      }),
    [sessionEnded]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let workspace: Workspace | null = null
      let signedIn = false
      try {
        workspace = await loadWorkspace()
        signedIn = workspace !== null && (!workspace.signIn || (await sessionStore.load()) !== null)
      } catch (error) {
        console.warn("[SixbMobile] Could not read the saved workspace.", error)
      }
      if (cancelled) return
      if (workspace && signedIn) connect(workspace)
      else setState({ status: "disconnected", address: workspace?.baseUrl ?? null, notice: null })
    })()
    return () => {
      cancelled = true
    }
  }, [connect])

  const open = useCallback(
    async (workspace: Workspace) => {
      await saveWorkspace(workspace)
      queryClient.clear()
      connect(workspace)
    },
    [connect, queryClient]
  )

  const leave = useCallback(async () => {
    if (state.status !== "connected") return
    const { workspace } = state
    await signOut(workspace)
    queryClient.clear()
    setState({ status: "disconnected", address: workspace.baseUrl, notice: null })
  }, [queryClient, state])

  const value = useMemo(() => ({ state, open, leave }), [state, open, leave])
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error("[SixbMobile] useWorkspace must be used inside WorkspaceProvider.")
  return value
}

/** The open workspace. Screens under `(app)` render only while one is open. */
export function useConnectedWorkspace(): {
  readonly workspace: Workspace
  readonly client: SixbClient
} {
  const { state } = useWorkspace()
  if (state.status !== "connected") {
    throw new Error("[SixbMobile] useConnectedWorkspace needs an open workspace.")
  }
  return state
}
