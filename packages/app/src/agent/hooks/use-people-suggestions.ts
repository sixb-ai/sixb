import { listUsersOptions } from "@sixb/client/hooks"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { useAgentThreadLists } from "./use-thread-lists"

/** Someone the share field can suggest: a member, with their email when the directory gave it. */
export interface PersonSuggestion {
  readonly id: string
  readonly name: string
  readonly email?: string
}

/** The most the field lists at once. */
const SUGGESTIONS = 6

/**
 * Who the share field suggests for what the owner typed. The people they already share threads
 * with come first: they reveal no one new. With `can.view(project.users)`, any member whose name
 * or email matches follows; without it, the directory is skipped and a typed email still works.
 * Before anything is typed, only those people show.
 */
export function usePeopleSuggestions(input: {
  readonly text: string
  /** User ids not to suggest: the reader, whoever is in the thread, and whoever is picked. */
  readonly exclude: ReadonlySet<string>
}) {
  const query = input.text.trim().toLowerCase()

  // Whether the reader may read the directory, asked once: the field's wording follows it.
  const directory = useQuery({
    ...listUsersOptions({ query: { limit: 1 } }),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const canSearch = directory.isSuccess
  const matches = useQuery({
    ...listUsersOptions({ query: { search: query, limit: SUGGESTIONS } }),
    enabled: canSearch && query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })

  const { threads, sharedThreads } = useAgentThreadLists({})
  const known = useMemo(() => {
    const people = new Map<string, PersonSuggestion>()
    const add = (principal: { readonly type: string; readonly id: string }, name?: string) => {
      if (principal.type !== "user" || people.has(principal.id)) return
      people.set(principal.id, { id: principal.id, name: name ?? principal.id })
    }
    // Newest first, as the lists come: whoever the reader worked with lately leads.
    for (const thread of [...sharedThreads, ...threads].sort(byRecency)) {
      add(thread.ownerPrincipal, thread.owner.displayName)
      for (const participant of thread.participants) {
        add(participant.principal, participant.principal.displayName)
      }
    }
    return [...people.values()]
  }, [threads, sharedThreads])

  const suggestions = useMemo(() => {
    const picked = new Map<string, PersonSuggestion>()
    const offer = (person: PersonSuggestion) => {
      if (input.exclude.has(person.id) || picked.has(person.id)) return
      picked.set(person.id, person)
    }

    for (const person of known) {
      if (!query || person.name.toLowerCase().includes(query)) offer(person)
    }
    if (query && canSearch) {
      for (const user of matches.data?.users ?? []) {
        if (user.status !== "active") continue
        const earlier = picked.get(user.id)
        // Someone from a thread keeps their place, and gains the email the directory knows.
        if (earlier) picked.set(user.id, { ...earlier, email: user.email })
        else offer({ id: user.id, name: user.displayName ?? user.email, email: user.email })
      }
    }
    return [...picked.values()].slice(0, SUGGESTIONS)
  }, [known, matches.data, query, canSearch, input.exclude])

  return { suggestions, canSearch }
}

function byRecency(
  a: { readonly lastMessageAt?: string | null; readonly updatedAt: string },
  b: { readonly lastMessageAt?: string | null; readonly updatedAt: string }
): number {
  return (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt)
}
