/**
 * Picks a project member for a `ref.user()` value. The value stays the member's id, so the forms
 * that parse it are unchanged.
 *
 * The list searches the member directory on the server. Reading it needs
 * `can.view(project.users)`; without it the picker falls back to a plain id input, so a member
 * who knows an id can still enter it.
 */
import { type GetUserResponse, isSixbApiError } from "@sixb/client"
import { userQueryOptions, usersQueryOptions, useUser } from "@sixb/client/hooks"
import { Combobox, type ComboboxOption, Input } from "@sixb/ui/components"
import { useDebouncedValue } from "@sixb/ui/hooks"
import { defineMessages, type MessageTree, type Translation } from "@sixb/ui/lib/i18n"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"

const SEARCH_DEBOUNCE_MS = 200
const PAGE_SIZE = 20
const NO_MEMBERS: readonly GetUserResponse[] = []

export const en = {
  select: "Select a member...",
  search: "Search by name or email...",
  loading: "Loading...",
  noMatch: "No members match.",
  loadFailed: "The members could not be loaded.",
  suspended: "Suspended",
  userId: "User ID",
} satisfies MessageTree

export const fr: Translation<typeof en> = {
  select: "Choisir un membre...",
  search: "Rechercher par nom ou e-mail...",
  loading: "Chargement...",
  noMatch: "Aucun membre ne correspond.",
  loadFailed: "Les membres n’ont pas pu être chargés.",
  suspended: "Compte suspendu",
  userId: "ID utilisateur",
}

const usePickerMessages = defineMessages<typeof en>({ en, fr }).useMessages

type Member = GetUserResponse
type PickerMessages = ReturnType<typeof usePickerMessages>

/**
 * One page of members matching what was typed, once typing pauses. The previous page stays on
 * screen while the next one loads. `denied` is true when the reader cannot read the directory.
 */
export function useMemberSearch(search: string) {
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS)
  const members = useQuery({
    ...usersQueryOptions({ search: debouncedSearch || undefined, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
    retry: false,
  })

  return {
    members: members.data?.users ?? NO_MEMBERS,
    searching: debouncedSearch !== "",
    loading: members.isFetching,
    failed: members.isError,
    denied: isSixbApiError(members.error) && members.error.status === 403,
  }
}

export function UserPicker({
  id,
  value,
  onChange,
  disabled,
  required,
  "aria-describedby": ariaDescribedBy,
}: {
  readonly id: string
  readonly value: string
  readonly onChange: (userId: string) => void
  readonly disabled?: boolean
  readonly required?: boolean
  readonly "aria-describedby"?: string
}) {
  const messages = usePickerMessages()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const directory = useMemberSearch(search)

  // A value set before the list loaded, or one the page does not hold, is named by its own lookup.
  const selectedId = value.trim()
  const selectedListed = directory.members.find((member) => member.id === selectedId)
  const selectedLookup = useUser(selectedId, {
    enabled: selectedId !== "" && !selectedListed && !directory.denied,
    retry: false,
  })
  const selected = selectedListed ?? selectedLookup.data ?? undefined

  // The chosen member stays first in the list until a search narrows it.
  const options = useMemo(() => {
    const pinned = selected && !selectedListed && !directory.searching ? [selected] : []
    return [...pinned, ...directory.members].map((member) => memberOption(member, messages))
  }, [selected, selectedListed, directory.members, directory.searching, messages])

  function choose(userId: string) {
    // Seeding the lookup names the choice at once, even once a search hides it.
    const member = directory.members.find((candidate) => candidate.id === userId)
    if (member) queryClient.setQueryData(userQueryOptions(member.id).queryKey, member)

    onChange(userId)
  }

  if (directory.denied) {
    return (
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        disabled={disabled}
        aria-describedby={ariaDescribedBy}
        placeholder={messages.userId}
      />
    )
  }

  const emptyLabel = directory.loading
    ? messages.loading
    : directory.failed
      ? messages.loadFailed
      : messages.noMatch

  return (
    <Combobox
      id={id}
      value={selectedId}
      options={options}
      onValueChange={choose}
      onSearchChange={setSearch}
      required={required}
      disabled={disabled}
      aria-describedby={ariaDescribedBy}
      placeholder={
        selected ? memberOption(selected, messages).label : selectedId || messages.select
      }
      searchPlaceholder={messages.search}
      emptyLabel={emptyLabel}
    />
  )
}

function memberOption(member: Member, messages: PickerMessages): ComboboxOption {
  const label = member.displayName ?? member.email
  const details = [
    member.displayName ? member.email : undefined,
    member.status === "suspended" ? messages.suspended : undefined,
  ].filter(Boolean)

  return {
    value: member.id,
    label,
    ...(details.length > 0 ? { description: details.join(" · ") } : {}),
  }
}
