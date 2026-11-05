import { useSyncExternalStore } from "react"

/** The systems a desktop app runs on. */
export type DesktopPlatform = "darwin" | "win32" | "linux"

/**
 * What the desktop app around this page offers it. The shell sets it before the page's first
 * script, and it never changes while the page is open.
 *
 * A deploy reaches an installed desktop app at once, while the shell stays as it was built. So a
 * page can run inside a shell older than itself: anything added here is optional, and a page checks
 * for it rather than for a version.
 */
export interface SixbDesktop {
  readonly platform: DesktopPlatform
  /** Running the agent on this computer, in folders the person chooses here. */
  readonly computer?: DesktopComputerAccess
}

/** This computer, as a conversation that runs on it names it. */
export interface DesktopComputer {
  readonly id: string
  readonly name: string
}

/**
 * What a page can ask of this computer. It names no path it wasn't given: folders come from a native
 * dialog the person answers, and allowing one that a conversation names asks them first.
 */
export interface DesktopComputerAccess {
  /**
   * Null where this desktop app can't run the agent. Rejects where it can, but what runs it couldn't
   * start: asking again tries again.
   */
  about(): Promise<DesktopComputer | null>
  /** The folders chosen on this computer for this project. */
  folders(): Promise<readonly string[]>
  /** Ask the person for a folder, which allows it. Null when they cancel. */
  pickFolder(): Promise<string | null>
  /** Ask the person to allow `folder`. Whether they did. */
  allowFolder(folder: string): Promise<boolean>
  forgetFolder(folder: string): Promise<void>
}

const PLATFORMS: readonly unknown[] = ["darwin", "win32", "linux"] satisfies DesktopPlatform[]

function isSixbDesktop(value: unknown): value is SixbDesktop {
  return (
    typeof value === "object" &&
    value !== null &&
    PLATFORMS.includes((value as { readonly platform?: unknown }).platform)
  )
}

function readDesktop(): SixbDesktop | null {
  const { sixbDesktop } = globalThis as { readonly sixbDesktop?: unknown }
  return isSixbDesktop(sixbDesktop) ? sixbDesktop : null
}

function readNoDesktop(): null {
  return null
}

function subscribeToNothing(): () => void {
  return () => {}
}

/**
 * The desktop app this page runs in, or null in a browser and in a desktop app built before this
 * existed. Right from the first render, so nothing flickers.
 *
 * It decides what to show, and grants nothing: a page can set this value itself. The shell's main
 * process checks whatever a desktop feature does.
 */
export function useDesktop(): SixbDesktop | null {
  return useSyncExternalStore(subscribeToNothing, readDesktop, readNoDesktop)
}
