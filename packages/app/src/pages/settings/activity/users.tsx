import { listActivityUsers } from "@sixb/client"
import { Button, Popover, PopoverContent, PopoverTrigger } from "@sixb/ui/components"
import { useInfiniteQuery } from "@tanstack/react-query"
import { Check, ChevronDown } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useActivityMessages } from "./messages"
import { activityQueryKey } from "./period"

const userPageSize = 100

export interface ActivityUsers {
  /** Display names of the users loaded so far, latest activity first. */
  readonly names: ReadonlyMap<string, string>
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly more: () => void
}

/** The signed-in users active in a period, a page at a time. */
export function useActivityUsers(period: {
  readonly from: string
  readonly to: string
}): ActivityUsers {
  const query = useInfiniteQuery({
    queryKey: [...activityQueryKey, "users", period.from, period.to],
    initialPageParam: undefined as { beforeAt: string; beforeId: string } | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listActivityUsers({
          query: { from: period.from, to: period.to, ...pageParam, limit: userPageSize },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => {
      const last = page.users.at(-1)
      return page.hasMore && last ? { beforeAt: last.lastSeenAt, beforeId: last.userId } : undefined
    },
    retry: false,
  })

  const users = query.data?.pages.flatMap((page) => page.users) ?? []
  return {
    names: new Map(users.map((user) => [user.userId, user.displayName ?? user.userId])),
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    more: () => void query.fetchNextPage(),
  }
}

export function UserFilter({
  userId,
  users,
  onChange,
}: {
  readonly userId: string | undefined
  readonly users: ActivityUsers
  readonly onChange: (userId: string | undefined) => void
}) {
  const messages = useActivityMessages()
  const [open, setOpen] = useState(false)
  const choose = (next: string | undefined) => {
    onChange(next)
    setOpen(false)
  }
  // The chosen user stays listed when the loaded pages hold none of their visits.
  const ids = [...new Set([...(userId ? [userId] : []), ...users.names.keys()])]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 min-w-0 flex-1 justify-between font-normal sm:max-w-72 sm:min-w-44 sm:flex-none"
          aria-label={messages.userFilter}
        >
          <span className="truncate">
            {userId ? (users.names.get(userId) ?? userId) : messages.allUsers}
          </span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)] p-1">
        <div className="max-h-72 overflow-y-auto">
          <UserOption selected={userId === undefined} onClick={() => choose(undefined)}>
            {messages.allUsers}
          </UserOption>
          {ids.map((id) => (
            <UserOption key={id} selected={id === userId} onClick={() => choose(id)}>
              {users.names.get(id) ?? id}
            </UserOption>
          ))}
        </div>
        {users.hasMore ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 w-full"
            disabled={users.loadingMore}
            onClick={users.more}
          >
            {messages.users.showMore}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function UserOption({
  selected,
  onClick,
  children,
}: {
  readonly selected: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[0.8125rem] hover:bg-muted"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <Check className="size-4 shrink-0" /> : null}
    </button>
  )
}
