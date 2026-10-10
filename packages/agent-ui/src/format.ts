import { type AgentMessages, en } from "./i18n/en"
import type { AgentThread } from "./types"

export type ThreadGroupKey = "today" | "yesterday" | "thisWeek" | "older"

export interface ThreadGroup {
  readonly key: ThreadGroupKey
  readonly threads: AgentThread[]
}

const DAY_MS = 86_400_000

/** Bucket threads into today / yesterday / the previous 7 days / older, preserving their order. */
export function groupThreadsByDate(threads: readonly AgentThread[]): ThreadGroup[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

  const today: AgentThread[] = []
  const yesterday: AgentThread[] = []
  const week: AgentThread[] = []
  const older: AgentThread[] = []

  for (const thread of threads) {
    const at = new Date(thread.lastMessageAt ?? thread.updatedAt).getTime()
    if (Number.isNaN(at) || at < startOfToday - 7 * DAY_MS) older.push(thread)
    else if (at >= startOfToday) today.push(thread)
    else if (at >= startOfToday - DAY_MS) yesterday.push(thread)
    else week.push(thread)
  }

  return [
    { key: "today" as const, threads: today },
    { key: "yesterday" as const, threads: yesterday },
    { key: "thisWeek" as const, threads: week },
    { key: "older" as const, threads: older },
  ].filter((group) => group.threads.length > 0)
}

/** Compact relative time for thread timestamps, e.g. "now", "5m", "3h", "2d", or a date. */
export function formatRelativeTime(
  iso: string | undefined,
  locale = "en",
  messages: AgentMessages["time"] = en.time
): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""

  const diffMs = Date.now() - then
  const seconds = Math.round(diffMs / 1000)
  if (seconds < 45) return messages.now
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return messages.minutes(minutes)
  const hours = Math.round(minutes / 60)
  if (hours < 24) return messages.hours(hours)
  const days = Math.round(hours / 24)
  if (days < 7) return messages.days(days)

  return new Date(then).toLocaleDateString(locale, { month: "short", day: "numeric" })
}
