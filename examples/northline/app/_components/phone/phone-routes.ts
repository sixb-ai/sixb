/**
 * How each route sits in the phone navigation: which tab it belongs to, whether it is a top-level
 * screen or a pushed one, and where its back button leads when there is no history to return to.
 */

export type PhoneTab = "home" | "service-cases" | "dispatch" | "equipment" | "more"

/** Top-level screens: they show their title, never a back button. */
const ROOTS: Readonly<Record<string, string>> = {
  "/": "Home",
  "/service-cases": "Service cases",
  "/dispatch": "Dispatch",
  "/equipment": "Equipment",
  "/technicians": "Technicians",
  "/quotes": "Quotes",
  "/contracts": "Contracts",
  "/customers": "Customers",
  "/threads": "Chats",
}

/** Records pushed on top of a root. Each takes its title from the page's own heading. */
const PUSHED: readonly RegExp[] = [
  /^\/service-cases\/[^/]+$/,
  /^\/equipment\/[^/]+$/,
  /^\/technicians\/[^/]+$/,
  /^\/customers\/[^/]+$/,
  /^\/threads\/[^/]+$/,
]

const CONVERSATION = /^\/threads\/[^/]+$/

/** Records a page opens in place from a query parameter, such as a quote's document on Quotes. */
const PUSHED_BY_QUERY: Readonly<Record<string, string>> = { "/quotes": "quote" }

export function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
}

/**
 * The screen a location shows: its path, plus the record a query parameter opens on top of it, so
 * `/quotes?quote=q-1` is a pushed screen with a back button rather than the Quotes list.
 */
export function screenPath(pathname: string, search = ""): string {
  const path = normalizePath(pathname)
  const parameter = PUSHED_BY_QUERY[path]
  const record = parameter ? new URLSearchParams(search).get(parameter) : null
  return record ? `${path}?${parameter}=${encodeURIComponent(record)}` : path
}

export function isRootPath(pathname: string): boolean {
  return Object.hasOwn(ROOTS, normalizePath(pathname))
}

/** A conversation fills the screen and brings its own composer where the tab bar would be. */
export function isConversationPath(pathname: string): boolean {
  return CONVERSATION.test(normalizePath(pathname))
}

/** The screen a back button returns to when the app was opened directly on this one. */
export function parentPath(pathname: string): string {
  const [path = "/", query] = pathname.split("?")
  if (query) return path
  const segments = normalizePath(path).split("/").filter(Boolean)
  while (segments.length > 1) {
    segments.pop()
    const candidate = `/${segments.join("/")}`
    if (isRootPath(candidate) || PUSHED.some((route) => route.test(candidate))) return candidate
  }
  return "/"
}

/** The short name of the screen a back button leads to. */
export function backLabel(pathname: string): string {
  return ROOTS[parentPath(pathname)] ?? "Back"
}

/** A title for the bar when the page has no heading of its own to borrow. */
export function fallbackTitle(pathname: string): string {
  return ROOTS[normalizePath(pathname)] ?? ""
}

export function tabFor(pathname: string): PhoneTab {
  const path = normalizePath(pathname)
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

  if (path === "/" || under("/threads")) return "home"
  if (under("/service-cases")) return "service-cases"
  if (under("/dispatch")) return "dispatch"
  if (under("/equipment")) return "equipment"
  return "more"
}
