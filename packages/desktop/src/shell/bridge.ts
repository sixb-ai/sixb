/** The name a page finds the desktop app under, through `useDesktop` in `@sixb/client/hooks`. */
export const DESKTOP_BRIDGE_NAME = "sixbDesktop"

/** How the page's `computer` methods reach the main process. */
export const COMPUTER_CHANNELS = {
  about: "sixb:computer:about",
  folders: "sixb:computer:folders",
  pickFolder: "sixb:computer:pick-folder",
  allowFolder: "sixb:computer:allow-folder",
  forgetFolder: "sixb:computer:forget-folder",
} as const

// Typed by `SixbDesktop` in `@sixb/client`, which the page reads: an `any` that a test holds to it.
// biome-ignore lint/suspicious/noExplicitAny: each channel answers its own type.
type Invoke = (channel: string, ...args: unknown[]) => Promise<any>

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
export function desktopBridge<const Platform extends NodeJS.Platform>(
  platform: Platform,
  invoke: Invoke
) {
  return {
    platform,
    computer: {
      about: () => invoke(COMPUTER_CHANNELS.about),
      folders: () => invoke(COMPUTER_CHANNELS.folders),
      pickFolder: () => invoke(COMPUTER_CHANNELS.pickFolder),
      allowFolder: (folder: string) => invoke(COMPUTER_CHANNELS.allowFolder, folder),
      forgetFolder: (folder: string) => invoke(COMPUTER_CHANNELS.forgetFolder, folder),
    },
  }
}
