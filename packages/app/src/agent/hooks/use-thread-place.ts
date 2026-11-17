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

export type ThreadPlaceBusy = "running" | "approval" | null

export interface ThreadPlace {
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
  readonly onComputer: boolean
  readonly currentComputer: ThreadComputer | null
  readonly computers: readonly PlaceComputer[]
  readonly loading: boolean
  readonly pending: boolean
  /** Where the move on its way goes: the cloud, or a folder on one of its owner's computers. */
  readonly movingTo: "cloud" | { readonly computerId: string; readonly folder: string } | null
  /** What keeps it where it runs: a reply in progress, or one waiting for approval. */
  readonly busy: ThreadPlaceBusy
  readonly error: "busy" | "failed" | null
  /** The last move to the cloud's error alone, for the notice that offers it. */
  readonly cloudError: "busy" | "failed" | null
  /** To the cloud: at once, or after asking when a message waits, as it would then run there. */
  readonly moveToCloud: () => void
  /** The question asked before a waiting message goes to the cloud. */
  readonly confirmCloud: {
    readonly open: boolean
    readonly setOpen: (open: boolean) => void
    readonly accept: () => void
  }
  readonly moveToFolder: (computer: PlaceComputer, folder: string) => void
  readonly pickFolder?: () => Promise<void>
  readonly forgetFolder?: (folder: string) => void
}

/**
 * Where an existing conversation runs, for its owner: switch between the cloud and any connected
 * computer or folder as needed. Null where there is nothing to choose, as for a new conversation:
 * in a browser, a cloud conversation that never moved, while none of its owner's computers is
 * connected.
 */
export function useThreadPlace(input: {
  readonly thread: AgentThread | null
  readonly access: ThreadAccess
  readonly busy: ThreadPlaceBusy
  /** A message waits for the computer: moving to the cloud runs it there. */
  readonly waiting: boolean
}): ThreadPlace | null {
  const { thread, access, busy, waiting } = input
  const active = thread !== null && access === "owner"
  const threadId = thread?.id ?? null
  const queryClient = useQueryClient()
  const desktopAccess: DesktopComputerAccess | null = useDesktop()?.computer ?? null

  // Which conversation the menu is open on: navigating away closes it, without an effect.
  const [openFor, setOpenFor] = useState<string | null>(null)
  // Which conversation the question before the cloud is asked on.
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null)
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

  // In a browser, a cloud conversation needs the list to know whether there's a choice at all: the
  // one a new conversation's picker reads, which the activity feed keeps current. A computer's
  // conversation always shows where it runs, and reads the list once its menu opens.
  const browser = desktopAccess === null
  const onComputer = thread?.runsOn === "computer"
  const listed = useQuery({
    ...listAgentComputersOptions(),
    enabled: active && browser && (open || !onComputer),
  })

  if (!active || !thread) return null

  const computers: readonly PlaceComputer[] = desktopAccess
    ? desktopComputer
      ? [{ id: desktopComputer.id, name: desktopComputer.name, folders: desktopFolders }]
      : []
    : (listed.data?.computers ?? [])

  // Open, it stays until closed: a computer that goes away meanwhile leaves the cloud to choose.
  // One that ran on a computer keeps it, so the way back stays where its owner last used it.
  const nothingToChoose =
    browser && !onComputer && !open && computers.length === 0 && thread.movedAt === undefined
  if (nothingToChoose) return null

  const currentComputer = thread.computer ?? null

  const computerPending = toComputer.isPending && toComputer.variables?.path.threadId === thread.id
  const cloudPending = toCloud.isPending && toCloud.variables?.path.threadId === thread.id
  const pending = computerPending || cloudPending
  const movingTo = cloudPending
    ? ("cloud" as const)
    : computerPending && toComputer.variables
      ? {
          computerId: toComputer.variables.body.computer.id,
          folder: toComputer.variables.body.computer.folder,
        }
      : null

  const computerError =
    toComputer.isError && toComputer.variables?.path.threadId === thread.id
      ? toComputer.error
      : null
  const cloudError =
    toCloud.isError && toCloud.variables?.path.threadId === thread.id ? toCloud.error : null
  const error = moveError(computerError ?? cloudError)

  const applyMoved = (moved: AgentThread) => {
    queryClient.setQueryData(getAgentThreadQueryKey({ path: { threadId: moved.id } }), moved)
    void queryClient.invalidateQueries({
      queryKey: listAgentThreadRunsQueryKey({ path: { threadId: moved.id } }),
    })
    void queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })
    setOpenFor(null)
  }

  const runInCloud = () => {
    if (pending || busy) return
    toCloud.mutate({ path: { threadId: thread.id } }, { onSuccess: applyMoved })
  }

  const moveToCloud = () => {
    if (!onComputer) {
      setOpenFor(null)
      return
    }
    if (pending || busy) return

    // The marker says what moved. A waiting message runs apart from its folder's files: ask first.
    if (waiting) {
      setOpenFor(null)
      setConfirmingFor(thread.id)
      return
    }
    runInCloud()
  }

  const confirmCloud = {
    open: confirmingFor === thread.id,
    setOpen: (next: boolean) => setConfirmingFor(next ? thread.id : null),
    accept: () => {
      setConfirmingFor(null)
      runInCloud()
    },
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

  return {
    open,
    setOpen,
    onComputer,
    currentComputer,
    computers,
    loading: browser && open && listed.isPending,
    pending,
    movingTo,
    busy,
    error,
    cloudError: moveError(cloudError),
    moveToCloud,
    confirmCloud,
    moveToFolder,
    ...(pickFolder ? { pickFolder } : {}),
    ...(forgetFolder ? { forgetFolder } : {}),
  }
}

/** Why a move failed: a turn it must wait for, or anything else. */
function moveError(error: unknown): "busy" | "failed" | null {
  if (error === null) return null
  return isSixbApiError(error) && error.code === "active_run_exists" ? "busy" : "failed"
}
