import { type GetAuthSessionResponse, setSharedAccessGuestName } from "@sixb/client"
import type { SixbSharedAccessSession } from "@sixb/client/browser"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

// A shared link opens the app for a visitor without an account: a guest. The bootstrap keeps its
// session here, so a page knows it reads as one, and never asks for a member's session.

const SHARED_SESSION_QUERY_KEY = ["sixb", "shared-session"] as const

/** The visitor of a shared link, as their session knows them. */
export interface SharedGuest {
  readonly grantId: string
  /** The page the link opens, within the app: where the guest goes back to. */
  readonly destinationPath: string
  /** The author id of the comments they write. */
  readonly id: string
  /** The name they gave, which their comments and presence carry; none until they give it. */
  readonly name?: string
}

/**
 * Keeps the shared link's session the bootstrap opened. Nobody is signed in: the member's session
 * is never asked for, as the boundary would refuse it.
 */
export function keepSharedSession(queries: QueryClient, session: SixbSharedAccessSession): void {
  const signedOut: GetAuthSessionResponse = { authenticated: false, authEnabled: true }
  queries.setQueryData(getAuthSessionQueryKey(), signedOut)
  queries.setQueryData(SHARED_SESSION_QUERY_KEY, session)
}

/** The guest reading through a shared link, or `null` for anyone else. */
export function useSharedGuest(): SharedGuest | null {
  const { data } = useQuery<SixbSharedAccessSession | null>({
    queryKey: SHARED_SESSION_QUERY_KEY,
    queryFn: () => null,
    // Only the bootstrap knows the session: nothing here fetches it.
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  if (!data) return null

  return {
    grantId: data.grantId,
    destinationPath: data.destinationPath,
    id: data.guestId,
    ...(data.guestName ? { name: data.guestName } : {}),
  }
}

/**
 * Gives the guest's name, which their session keeps for their comments and presence. Rejects when
 * the API refuses it, so a form can say why.
 */
export function useGiveGuestName(): (name: string) => Promise<void> {
  const queries = useQueryClient()

  return useCallback(
    async (name: string) => {
      const session = queries.getQueryData<SixbSharedAccessSession>(SHARED_SESSION_QUERY_KEY)
      if (!session) throw new Error("[SixbApp] Only a shared link's visitor gives a guest name.")

      const { data } = await setSharedAccessGuestName({
        path: { grantId: session.grantId },
        body: { name },
        throwOnError: true,
      })
      queries.setQueryData(SHARED_SESSION_QUERY_KEY, data)
    },
    [queries]
  )
}
