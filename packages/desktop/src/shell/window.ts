import type { ShellConfig } from "./navigation"

/**
 * Whether the window itself may show `url`: only the app and the API that serves its sign-in
 * pages. Anything else a page links to opens in the user's browser instead.
 */
export function mayNavigate(config: ShellConfig, url: string): boolean {
  try {
    const { origin } = new URL(url)
    return origin === new URL(config.appUrl).origin || origin === new URL(config.apiOrigin).origin
  } catch {
    return false
  }
}

/**
 * Whether `url` is on the app's own origin. Camera, location and the like are the app's to ask for,
 * and not a frame it embeds from elsewhere.
 */
export function isAppUrl(config: ShellConfig, url: string): boolean {
  try {
    return new URL(url).origin === new URL(config.appUrl).origin
  } catch {
    return false
  }
}

/**
 * What the window paints before a page has: the loading page's own background, so the window
 * opens, and passes from that page to the app, without a flash of white.
 */
export const WINDOW_BACKGROUND = { light: "#fafafa", dark: "#0a0a0a" } as const

/**
 * What the window's page runs with. The page is remote: it gets no Node and a world apart from the
 * preload's, on every platform, and reaches the shell only through what the preload exposes.
 */
export function pageWebPreferences(preload: string) {
  return { sandbox: true, contextIsolation: true, nodeIntegration: false, preload }
}

/** Only macOS draws window controls over the page; elsewhere the title bar stays. */
export function hasHiddenTitleBar(platform: NodeJS.Platform): boolean {
  return platform === "darwin"
}

/** The band at the top of a window without a title bar where macOS draws the window controls. */
export const CONTROLS_HEIGHT_PX = 36

/**
 * Styles for a window without a title bar, inserted into every page it shows.
 *
 * The page reaches the top edge, under the window controls, so two things a title bar did have
 * to come from the page: somewhere to grab the window, and room for the controls.
 *  - `#sixb-desktop-drag` (added by the preload) is the drag handle: a strip across the top, above
 *    the page. It ignores the pointer, and every control is cut out of the draggable area, so
 *    buttons and links under the strip still take their clicks and the space between them moves
 *    the window. Something clickable that is none of the things listed here needs
 *    `-webkit-app-region: no-drag` of its own.
 *  - The shared sidebar is moved down so most apps need nothing. Other layouts can use
 *    `html[data-sixb-desktop]` and `--sixb-desktop-controls-height`, which the preload sets.
 */
export const HIDDEN_TITLE_BAR_CSS = [
  `#sixb-desktop-drag{position:fixed;top:0;left:0;right:0;height:${CONTROLS_HEIGHT_PX}px;`,
  "z-index:2147483647;pointer-events:none;-webkit-app-region:drag}",
  `${[
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "label",
    "[role=button]",
    "[role=link]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=switch]",
    "[role=checkbox]",
    "[role=combobox]",
    "[contenteditable]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",")}{-webkit-app-region:no-drag}`,
  `[data-slot="sidebar-inner"]{padding-top:calc(${CONTROLS_HEIGHT_PX}px - 0.5rem)}`,
].join("")
