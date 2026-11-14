import { isSixbApiError } from "@sixb/client"
import {
  type DesktopComputer,
  type DesktopComputerAccess,
  getAgentThreadQueryKey,
  listAgentComputersOptions,
  listAgentThreadRunsQueryKey,
  listAgentThreadsQueryKey,
  moveAgentThreadToCloudMutation,
  moveAgentThreadToComputerMutation,
  useDesktop,
} from "@sixb/client/hooks"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import type { ThreadComputer } from "../components/computer-place"
import type { ThreadAccess } from "../sharing"
import type { AgentThread } from "../types"
import type { PlaceComputer } from "./use-new-thread-place"

export interface ThreadPlace {
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
  readonly onComputer: boolean
  readonly currentComputer: ThreadComputer | null
  readonly computers: readonly PlaceComputer[]
  /** True in a browser (names each computer); false in Sixb Desktop (this computer alone). */
  readonly remote: boolean
  readonly loading: boolean
  readonly pending: boolean
  readonly busy: boolean
  readonly error: "busy" | "failed" | null
  readonly moveToCloud: () => void
  readonly moveToFolder: (computer: PlaceComputer, folder: string) => void
  readonly pickFolder?: () => Promise<void>
  readonly forgetFolder?: (folder: string) => void
}

/**
 * Where an existing conversation runs, for its owner: switch between the cloud and any connected
 * computer or folder as needed. Queries connected computers lazily when the menu opens so opening
 * a conversation in a browser adds no extra request.
 */
export function useThreadPlace(input: {
  readonly thread: AgentThread | null
  readonly access: ThreadAccess
  readonly busy: boolean
}): ThreadPlace | null {
  const { thread, access, busy } = input
  const active = thread !== null && access === "owner"
  const threadId = thread?.id ?? null
  const queryClient = useQueryClient()
  const desktopAccess: DesktopComputerAccess | null = useDesktop()?.computer ?? null

  // Which conversation the menu is open on: navigating away closes it, without an effect.
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [desktopComputer, setDesktopComputer] = useState<DesktopComputer | null>(null)
  const [desktopFolders, setDesktopFolders] = useState<readonly string[]>([])

  const toComputer = useMutation(moveAgentThreadToComputerMutation())
  const toCloud = useMutation(moveAgentThreadToCloudMutation())

  const refreshDesktop = useCallback(() => {
    if (!desktopAccess) return
    void desktopAccess.about().then(setDesktopComputer, () => {})
    void desktopAccess.folders().then(setDesktopFolders, () => {})
  }, [desktopAccess])

  const open = threadId !== null && openFor === threadId
  // Opening it starts from no error, and reads Sixb Desktop's folders again.
  const setOpen = (next: boolean) => {
    if (next) {
      toComputer.reset()
      toCloud.reset()
      refreshDesktop()
    }
    setOpenFor(next ? threadId : null)
  }

  const listed = useQuery({
    ...listAgentComputersOptions(),
    enabled: active && open && desktopAccess === null,
  })

  if (!active || !thread) return null

  const onComputer = thread.runsOn === "computer"
  const currentComputer = thread.computer ?? null

  const computerPending = toComputer.isPending && toComputer.variables?.path.threadId === thread.id
  const cloudPending = toCloud.isPending && toCloud.variables?.path.threadId === thread.id
  const pending = computerPending || cloudPending

  const computerError =
    toComputer.isError && toComputer.variables?.path.threadId === thread.id
      ? toComputer.error
      : null
  const cloudError =
    toCloud.isError && toCloud.variables?.path.threadId === thread.id ? toCloud.error : null
  const activeError = computerError ?? cloudError
  const error: "busy" | "failed" | null =
    activeError === null
      ? null
      : isSixbApiError(activeError) && activeError.code === "active_run_exists"
        ? "busy"
        : "failed"

  const applyMoved = (moved: AgentThread) => {
    queryClient.setQueryData(getAgentThreadQueryKey({ path: { threadId: moved.id } }), moved)
    void queryClient.invalidateQueries({
      queryKey: listAgentThreadRunsQueryKey({ path: { threadId: moved.id } }),
    })
    void queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
    setOpenFor(null)
  }

  const moveToCloud = () => {
    if (!onComputer) {
      setOpenFor(null)
      return
    }
    if (pending || busy) return
    toCloud.mutate({ path: { threadId: thread.id } }, { onSuccess: applyMoved })
  }

  const moveToFolder = (computer: PlaceComputer, folder: string) => {
    if (!computer.id || !computer.name) return
    if (onComputer && currentComputer?.id === computer.id && currentComputer.folder === folder) {
      setOpenFor(null)
      return
    }
    if (pending || busy) return
    toComputer.mutate(
      {
        path: { threadId: thread.id },
        body: { computer: { id: computer.id, name: computer.name, folder } },
      },
      { onSuccess: applyMoved }
    )
  }

  const pickFolder = desktopAccess
    ? async () => {
        if (pending || busy) return
        const folder = await desktopAccess.pickFolder()
        if (!folder) return
        const found = desktopComputer ?? (await desktopAccess.about().catch(() => null))
        refreshDesktop()
        if (!found) return
        moveToFolder({ id: found.id, name: found.name, folders: desktopFolders }, folder)
      }
    : undefined

  const forgetFolder = desktopAccess
    ? (folder: string) => {
        void desktopAccess.forgetFolder(folder).then(refreshDesktop, () => {})
      }
    : undefined

  const computers: readonly PlaceComputer[] = desktopAccess
    ? desktopComputer
      ? [{ id: desktopComputer.id, name: desktopComputer.name, folders: desktopFolders }]
      : []
    : (listed.data?.computers ?? [])

  return {
    open,
    setOpen,
    onComputer,
    currentComputer,
    computers,
    remote: desktopAccess === null,
    loading: desktopAccess === null && open && listed.isPending,
    pending,
    busy,
    error,
    moveToCloud,
    moveToFolder,
    ...(pickFolder ? { pickFolder } : {}),
    ...(forgetFolder ? { forgetFolder } : {}),
  }
}
