/** The name a page finds the desktop app under, through `useDesktop` in `@sixb/client/hooks`. */
export const DESKTOP_BRIDGE_NAME = "sixbDesktop"

/**
 * What the shell offers the page. `SixbDesktop` in `@sixb/client` is the page's view of this, and
 * `tests/app.test.ts` holds the two together.
 *
 * The page is remote, and anything here is open to whatever runs in it. To offer more:
 *  1. Add one narrow method here, calling `ipcRenderer.invoke`, never a general way to run a command
 *     or read a file. The page asks; the person decides, in a native dialog, what it gets.
 *  2. Handle it in `main.ts`, refusing any sender that `isAppUrl` does not accept.
 *  3. Add it to `SixbDesktop` as optional, because a page can outlive the shell it runs in.
 */
export function desktopBridge<const Platform extends NodeJS.Platform>(platform: Platform) {
  return { platform }
}
