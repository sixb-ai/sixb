import type { UserRef } from "@sixb/core"
import { queryOptions, type UseQueryResult, useQuery } from "@tanstack/react-query"
import { useSixbProviderClient } from "./client-provider"
import { listUsersQueryKey } from "./generated/@tanstack/react-query.gen"
import type { Client } from "./generated/client"
import { getUser, listUsers } from "./generated/sdk.gen"
import type { GetUserResponse, ListUsersData, ListUsersResponse } from "./generated/types.gen"
import type { QueryHookExtras } from "./query-hooks"

export type UseUsersOptions = NonNullable<ListUsersData["query"]> &
  QueryHookExtras & {
    /** hey-api client override. Defaults to the nearest SixbProvider client, then the global client. */
    readonly client?: Client
  }

export type UseUserOptions = QueryHookExtras & {
  /** hey-api client override. Defaults to the nearest SixbProvider client, then the global client. */
  readonly client?: Client
}

/** Query options for one page of the member directory, for prefetching or `useQuery`. */
export function usersQueryOptions(options: UseUsersOptions = {}) {
  const { client, status, search, limit, offset, ...extras } = options
  const query = { status, search, limit, offset }

  return queryOptions<ListUsersResponse, Error>({
    ...extras,
    queryKey: listUsersQueryKey({ query }),
    queryFn: async ({ signal }) => {
      const { data } = await listUsers<true>({ client, query, signal, throwOnError: true })
      return data
    },
  })
}

/** A member by user reference, id, or email: the email matches exactly, ignoring case. */
export type UserLookupInput = UserRef | string | { readonly email: string }

/**
 * Query options for one member, for prefetching or `useQuery`. The data is `null` when no member
 * has this id or email, or the reader cannot read the directory.
 */
export function userQueryOptions(user: UserLookupInput, options: UseUserOptions = {}) {
  if (typeof user === "object" && "email" in user) {
    return userByEmailQueryOptions(user.email, options)
  }

  const { client, ...extras } = options
  const path = { userId: typeof user === "string" ? user : user.id }

  return queryOptions<GetUserResponse | null, Error>({
    ...extras,
    // Not the generated `getUserQueryKey`: `getUserOptions` caches only members, never `null`.
    queryKey: [{ _id: "user", path }] as const,
    queryFn: async ({ signal }) => {
      // Read the status rather than throw: a hidden or unknown member is an answer, cached as
      // no one, not a failure each reader asks again.
      const { data, error, response } = await getUser({
        client,
        path,
        signal,
        responseStyle: "fields",
        throwOnError: false,
      })
      if (response?.status === 403 || response?.status === 404) return null
      if (error !== undefined) throw error

      return data
    },
  })
}

function userByEmailQueryOptions(email: string, options: UseUserOptions) {
  const { client, ...extras } = options
  // The server ignores case, so the cache does too.
  const query = { email: email.trim().toLowerCase() }

  return queryOptions<GetUserResponse | null, Error>({
    ...extras,
    queryKey: [{ _id: "user", query }] as const,
    queryFn: async ({ signal }) => {
      const { data, error, response } = await listUsers({
        client,
        query,
        signal,
        responseStyle: "fields",
        throwOnError: false,
      })
      if (response?.status === 403) return null
      if (error !== undefined) throw error

      return data.users[0] ?? null
    },
  })
}

/**
 * One page of the project's member directory, active members by default. Pass `status: "all"`
 * to include suspended members. Reading it requires `can.view(project.users)`.
 */
export function useUsers(options: UseUsersOptions = {}): UseQueryResult<ListUsersResponse, Error> {
  const providerClient = useSixbProviderClient()

  return useQuery(usersQueryOptions({ ...options, client: options.client ?? providerClient }))
}

/**
 * One member of the directory, from a user reference, an id, or `{ email }`: `null` when no member
 * has it, or without `can.view(project.users)`.
 */
export function useUser(
  user: UserLookupInput,
  options: UseUserOptions = {}
): UseQueryResult<GetUserResponse | null, Error> {
  const providerClient = useSixbProviderClient()

  return useQuery(userQueryOptions(user, { ...options, client: options.client ?? providerClient }))
}
