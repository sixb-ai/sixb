import { type GetAuthSessionResponse, signOut } from "@sixb/client"
import { getAuthSessionOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useCallback } from "react"

/** The signed-in person: their id, email, display name, avatar and groups. */
export type CurrentUser = Extract<GetAuthSessionResponse, { readonly authenticated: true }>["user"]

/** Which Settings pages about the project the signed-in person may open. */
export type SessionAccess = Extract<
  GetAuthSessionResponse,
  { readonly authenticated: true }
>["access"]

/**
 * The signed-in person, or `null` when auth is off or nobody is signed in.
 *
 * The app loads the session before its first render and keeps it in the query cache, so inside a
 * Sixb app this returns at once instead of fetching the session again.
 */
export function useCurrentUser(): CurrentUser | null {
  const { data } = useQuery({ ...getAuthSessionOptions(), staleTime: Number.POSITIVE_INFINITY })
  return data?.authenticated ? data.user : null
}

/** What the signed-in person may open, or `null` when nobody is signed in. */
export function useSessionAccess(): SessionAccess | null {
  const { data } = useQuery({ ...getAuthSessionOptions(), staleTime: Number.POSITIVE_INFINITY })
  return data?.authenticated ? data.access : null
}

/**
 * Returns a function that signs out and reloads, which sends the browser to sign in again. The
 * promise rejects when the API refuses, so a button can recover.
 */
export function useSignOut(): () => Promise<void> {
  return useCallback(async () => {
    await signOut({ throwOnError: true })
    window.location.reload()
  }, [])
}
