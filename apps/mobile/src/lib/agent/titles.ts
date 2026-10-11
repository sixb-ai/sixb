const TITLE_LENGTH = 60

/** A new chat's title: the first line of its first message, cut to fit a list row. */
export function firstMessageTitle(text: string): string {
  const firstLine = text.split("\n", 1)[0]?.trim() ?? text
  return firstLine.length > TITLE_LENGTH ? `${firstLine.slice(0, TITLE_LENGTH - 1)}…` : firstLine
}

/** The title to show for a chat, or `fallback` for one saved without a title. */
export function chatTitle(
  thread: { readonly title?: string | null } | null | undefined,
  fallback = "Untitled chat"
): string {
  return thread?.title?.trim() || fallback
}
