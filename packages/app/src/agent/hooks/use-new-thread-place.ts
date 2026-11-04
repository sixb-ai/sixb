import { type DesktopComputer, type DesktopComputerAccess, useDesktop } from "@sixb/client/hooks"
import { useCallback, useEffect, useState } from "react"

const STORAGE_KEY = "sixb.agent.new-thread-place"

/** The last choice, on this computer: where a new conversation starts. */
interface StoredPlace {
  readonly cloud: boolean
  readonly folder: string | null
}

function readStored(): StoredPlace {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<StoredPlace>
    return { cloud: stored?.cloud === true, folder: stored?.folder ?? null }
  } catch {
    return { cloud: false, folder: null }
  }
}

/** What a new conversation is created with to run on this computer: nothing, for the cloud. */
export type NewThreadPlaceBody =
  | { readonly runsOn?: undefined }
  | {
      readonly runsOn: "computer"
      readonly computer: DesktopComputer & { readonly folder: string }
    }

/** The composer's choice of where a new conversation runs. */
export interface NewThreadPlace {
  readonly computerName: string
  readonly cloud: boolean
  /** Null before the person has chosen one: the first message asks. */
  readonly folder: string | null
  /** Folders chosen before, to choose from again. */
  readonly folders: readonly string[]
  readonly chooseCloud: () => void
  readonly chooseFolder: (folder: string) => void
  /** Ask the person for a folder, and use it. */
  readonly pickFolder: () => Promise<void>
  readonly forgetFolder: (folder: string) => void
  readonly refreshFolders: () => void
}

/**
 * Where a new conversation runs, in a desktop app that can run the agent here: this computer unless
 * the person chooses the cloud. In a browser there's nothing to choose, and this says so.
 */
export function useNewThreadPlace(): {
  /** Null where the only place is the cloud, or until it's known that there's another. */
  readonly place: NewThreadPlace | null
  /** A desktop app that hasn't said yet whether it can run the agent here. */
  readonly waiting: boolean
  /**
   * What to create the next conversation with, asking for a folder if none is chosen. Null when the
   * person cancels, so that their message stays in the composer.
   */
  readonly resolveBody: () => Promise<NewThreadPlaceBody | null>
} {
  const access: DesktopComputerAccess | null = useDesktop()?.computer ?? null
  // Undefined until the desktop app answers; null where it can't run the agent.
  const [computer, setComputer] = useState<DesktopComputer | null | undefined>(undefined)
  // Null until the runner has said: a folder chosen before isn't taken as gone meanwhile.
  const [folders, setFolders] = useState<readonly string[] | null>(null)
  const [stored, setStored] = useState(readStored)

  const remember = useCallback((next: StoredPlace) => {
    setStored(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Private storage: the choice lasts as long as the page.
    }
  }, [])

  const refreshFolders = useCallback(() => {
    void access?.folders().then(setFolders, () => {})
  }, [access])

  useEffect(() => {
    if (!access) return
    let current = true
    const refresh = () => {
      void access.about().then(
        (found) => {
          if (current) setComputer(found)
        },
        () => {}
      )
      refreshFolders()
    }
    refresh()
    // A runner that couldn't start when this first asked may have since.
    window.addEventListener("focus", refresh)
    return () => {
      current = false
      window.removeEventListener("focus", refresh)
    }
  }, [access, refreshFolders])

  if (!access) return { place: null, waiting: false, resolveBody: async () => ({}) }

  const pick = async (): Promise<string | null> => {
    const folder = await access.pickFolder()
    if (folder) {
      remember({ cloud: false, folder })
      refreshFolders()
    }
    return folder
  }

  // Asks the runner rather than reading what's shown: a message sent before it has answered goes
  // where the person last chose, not to the cloud by default.
  const resolveBody = async (): Promise<NewThreadPlaceBody | null> => {
    const found = await access.about()
    if (!found || stored.cloud) return {}
    // A folder that's no longer allowed here, or no longer there, or a sign-in that ended: asking
    // again allows it, and signs in. Anything else would leave the message waiting on nothing.
    const allowed = await access.folders()
    const folder = stored.folder && allowed.includes(stored.folder) ? stored.folder : await pick()
    return folder ? { runsOn: "computer", computer: { ...found, folder } } : null
  }

  if (!computer) return { place: null, waiting: computer === undefined, resolveBody }

  return {
    waiting: false,
    place: {
      computerName: computer.name,
      cloud: stored.cloud,
      folder: stored.folder && (!folders || folders.includes(stored.folder)) ? stored.folder : null,
      folders: folders ?? [],
      chooseCloud: () => remember({ ...stored, cloud: true }),
      chooseFolder: (folder) => remember({ cloud: false, folder }),
      pickFolder: async () => {
        await pick()
      },
      forgetFolder: (folder) => {
        void access.forgetFolder(folder).then(refreshFolders, () => {})
        if (stored.folder === folder) remember({ ...stored, folder: null })
      },
      refreshFolders,
    },
    resolveBody,
  }
}
