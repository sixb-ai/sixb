import { type AddAgentThreadParticipantsData, isSixbApiError } from "@sixb/client"
import {
  addAgentThreadParticipantsMutation,
  forkAgentThreadMutation,
  getAgentThreadQueryKey,
  listAgentThreadsQueryKey,
  removeAgentThreadParticipantMutation,
} from "@sixb/client/hooks"
import { toast } from "@sixb/ui/components"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { type ParticipantChoice, participantChoiceLabel } from "../components/participant-input"
import { useAgentMessages } from "../i18n"
import { personName, samePrincipal, threadParticipants } from "../sharing"
import type { AgentThread } from "../types"

export interface UseThreadSharingInput {
  readonly thread: AgentThread | null
  /** Open the copy a fork made. */
  readonly onForked: (threadId: string) => void
  /** Leave the conversation the reader no longer takes part in. */
  readonly onLeft: () => void
  /** The chat's own toaster, so a toast shows once however many chats are mounted. */
  readonly toasterId: string
}

/** Why sharing failed: someone the server refused, or anything else. */
export type ShareFailure = "invalid" | "failed"

export type ThreadSharing = ReturnType<typeof useThreadSharing>

/**
 * What changes who takes part in a conversation: its owner adds and removes people, a participant
 * leaves, and anyone who reads it continues it in a copy of their own. Its state belongs to one
 * thread: switching threads starts it over.
 */
export function useThreadSharing({ thread, onForked, onLeft, toasterId }: UseThreadSharingInput) {
  const labels = useAgentMessages().sharing
  const queryClient = useQueryClient()
  const done = (message: string) => toast.success(message, { toasterId })
  const addParticipants = useMutation(addAgentThreadParticipantsMutation())
  const removeParticipant = useMutation(removeAgentThreadParticipantMutation())
  const leaveThread = useMutation(removeAgentThreadParticipantMutation())
  const forkThread = useMutation(forkAgentThreadMutation())
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set())

  const threadId = thread?.id ?? null
  const currentThreadId = useRef(threadId)
  currentThreadId.current = threadId

  const { reset: resetAdd } = addParticipants
  const { reset: resetRemove } = removeParticipant
  const { reset: resetLeave } = leaveThread
  const { reset: resetFork } = forkThread

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new thread is the reason to reset.
  useEffect(() => {
    resetAdd()
    resetRemove()
    resetLeave()
    resetFork()
    setRemoving(new Set())
  }, [threadId, resetAdd, resetRemove, resetLeave, resetFork])

  const threadKey = (id: string) => getAgentThreadQueryKey({ path: { threadId: id } })

  const refreshLists = () => queryClient.invalidateQueries({ queryKey: listAgentThreadsQueryKey() })

  const share = async (people: readonly ParticipantChoice[]) => {
    if (!thread || people.length === 0) return false

    try {
      const updated = await addParticipants.mutateAsync({
        path: { threadId: thread.id },
        body: { users: people.map(participantInput) },
      })

      // A read that started before the change must not put the old people back.
      await queryClient.cancelQueries({ queryKey: threadKey(thread.id) })
      queryClient.setQueryData(threadKey(thread.id), updated)
      void refreshLists()

      done(labels.sharedWith(addedNames(thread, updated, people)))
      return true
    } catch {
      return false
    }
  }

  const remove = async (userId: string) => {
    if (!thread) return false

    const person = threadParticipants(thread).find((entry) => entry.principal.id === userId)
    setRemoving((current) => new Set(current).add(userId))
    try {
      await removeParticipant.mutateAsync({ path: { threadId: thread.id, userId } })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: threadKey(thread.id) }),
        refreshLists(),
      ])

      done(labels.removed(person ? personName(person) : userId))
      return true
    } catch {
      return false
    } finally {
      setRemoving((current) => {
        const next = new Set(current)
        next.delete(userId)
        return next
      })
    }
  }

  const leave = async (userId: string) => {
    if (!thread) return false

    try {
      await leaveThread.mutateAsync({ path: { threadId: thread.id, userId } })
    } catch {
      return false
    }

    queryClient.removeQueries({ queryKey: threadKey(thread.id) })
    void refreshLists()

    done(labels.left)
    onLeft()
    return true
  }

  const fork = async () => {
    if (!thread) return

    const source = thread.id
    try {
      const { thread: copy } = await forkThread.mutateAsync({ path: { threadId: source } })
      void refreshLists()

      // The reader may have moved on while the copy was made: it then waits in their history.
      done(labels.copied)
      if (currentThreadId.current === source) onForked(copy.id)
    } catch {
      // The error shows where the button is.
    }
  }

  return {
    share,
    sharing: addParticipants.isPending,
    shareFailure: shareFailure(addParticipants.error),
    resetShare: addParticipants.reset,
    remove,
    removing,
    removeFailed: removeParticipant.isError,
    leave,
    leaving: leaveThread.isPending,
    leaveFailed: leaveThread.isError,
    fork,
    forking: forkThread.isPending,
    forkFailed: forkThread.isError,
  }
}

/**
 * Who a share added, by name: the people the thread did not have before, or else what the owner
 * typed, as an account may have no name.
 */
function addedNames(
  before: AgentThread,
  after: AgentThread,
  staged: readonly ParticipantChoice[]
): readonly string[] {
  const added = threadParticipants(after).filter(
    (person) =>
      !before.participants.some((participant) =>
        samePrincipal(participant.principal, person.principal)
      )
  )
  if (added.length > 0 && added.every((person) => person.displayName)) return added.map(personName)

  return staged.map(participantChoiceLabel)
}

/** Someone the server refused is said in our words, never the server's: it may name an account. */
function shareFailure(error: unknown): ShareFailure | null {
  if (!error) return null

  return isSixbApiError(error) && error.code === "invalid_participant" ? "invalid" : "failed"
}

/** Someone to add, as the server takes them: by id, or by their account's email. */
type ParticipantInput = AddAgentThreadParticipantsData["body"]["users"][number]

function participantInput(choice: ParticipantChoice): ParticipantInput {
  return choice.kind === "user" ? { type: "user", id: choice.id } : { email: choice.email }
}
