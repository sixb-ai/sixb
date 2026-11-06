import {
  type DesktopComputer,
  type DesktopComputerAccess,
  listAgentComputersOptions,
  useDesktop,
} from "@sixb/client/hooks"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"

const STORAGE_KEY = "sixb.agent.new-thread-place"
/** In a browser: the folder chosen last, on one of the person's computers. */
const ONLINE_STORAGE_KEY = "sixb.agent.new-thread-place.online"

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

/** A message that's to run on this computer, and what runs it there can't start. */
export class ComputerUnavailableError extends Error {
  constructor(cause: unknown) {
    super("[SixbApp] What runs the agent on this computer couldn't start.", { cause })
    this.name = "ComputerUnavailableError"
  }
}

/** What a new conversation is created with to run on this computer: nothing, for the cloud. */
export type NewThreadPlaceBody =
  | { readonly runsOn?: undefined }
  | {
      readonly runsOn: "computer"
      readonly computer: DesktopComputer & { readonly folder: string }
    }

/** A computer a new conversation can run on, with the folders to choose from there. */
export interface PlaceComputer {
  /** Both null while what runs the agent on this computer can't start: the cloud is still a choice. */
  readonly id: string | null
  readonly name: string | null
  readonly folders: readonly string[]
}

/** The composer's choice of where a new conversation runs. */
export interface NewThreadPlace {
  /**
   * In a desktop app, this computer alone. In a browser, the person's computers with `sixb` open,
   * which aren't the one the page is on.
   */
  readonly computers: readonly PlaceComputer[]
  /** The computers are elsewhere: what's shown names the computer as well as the folder. */
  readonly remote: boolean
  readonly cloud: boolean
  /** Null before the person has chosen one: in a desktop app, the first message asks. */
  readonly chosen: { readonly computer: PlaceComputer; readonly folder: string } | null
  readonly chooseCloud: () => void
  readonly chooseFolder: (computer: PlaceComputer, folder: string) => void
  /** In a desktop app: ask the person for a folder, and use it. */
  readonly pickFolder?: () => Promise<void>
  /** In a desktop app: take a folder back. */
  readonly forgetFolder?: (folder: string) => void
  /**
   * In a desktop app: read this computer's folders again, as the menu opens. A browser's list
   * follows the activity feed instead.
   */
  readonly refreshFolders?: () => void
}

export interface NewThreadPlaceState {
  /** Null where the only place is the cloud, or until it's known that there's another. */
  readonly place: NewThreadPlace | null
  /** A desktop app that hasn't said yet whether it can run the agent here. */
  readonly waiting: boolean
  /** This computer, once the desktop app has said: what tells a conversation that runs on it. */
  readonly computerId: string | null
  /**
   * What to create the next conversation with, asking for a folder if none is chosen. Null when the
   * person cancels, so that their message stays in the composer.
   */
  readonly resolveBody: () => Promise<NewThreadPlaceBody | null>
}

/**
 * Where a new conversation runs. In a desktop app that can run the agent here: this computer
 * unless the person chooses the cloud. In a browser: the cloud unless they choose a folder on one
 * of their computers where `sixb` is open now, and there's nothing to choose while none is.
 *
 * `starting`: a new conversation is open. Only then does a browser list the person's computers.
 */
export function useNewThreadPlace(starting: boolean): NewThreadPlaceState {
  const access: DesktopComputerAccess | null = useDesktop()?.computer ?? null
  const desktop = useDesktopPlace(access)
  const online = useOnlineComputersPlace(starting && access === null)
  return desktop ?? online
}

/** In a desktop app that can run the agent here; null elsewhere. */
function useDesktopPlace(access: DesktopComputerAccess | null): NewThreadPlaceState | null {
  // Undefined until the desktop app answers; null where it can't run the agent.
  const [computer, setComputer] = useState<DesktopComputer | null | undefined>(undefined)
  const [cannotStart, setCannotStart] = useState(false)
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
          if (!current) return
          setComputer(found)
          setCannotStart(false)
        },
        () => {
          if (current) setCannotStart(true)
        }
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

  if (!access) return null

  const pick = async (): Promise<string | null> => {
    const folder = await access.pickFolder()
    if (folder) {
      remember({ cloud: false, folder })
      refreshFolders()
    }
    return folder
  }

  // Asks the runner rather than reading what's shown: a message sent before it has answered goes
  // where the person last chose, not to the cloud by default. One it can't start for says so.
  const resolveBody = async (): Promise<NewThreadPlaceBody | null> => {
    if (stored.cloud) return {}
    const found = await access.about().catch((cause: unknown) => {
      throw new ComputerUnavailableError(cause)
    })
    if (!found) return {}
    // A folder that's no longer allowed here, or no longer there, or a sign-in that ended: asking
    // again allows it, and signs in. Anything else would leave the message waiting on nothing.
    const allowed = await access.folders()
    const folder = stored.folder && allowed.includes(stored.folder) ? stored.folder : await pick()
    return folder ? { runsOn: "computer", computer: { ...found, folder } } : null
  }

  if (computer === null || (computer === undefined && !cannotStart)) {
    return { place: null, waiting: computer === undefined, computerId: null, resolveBody }
  }

  const here: PlaceComputer = {
    id: computer?.id ?? null,
    name: computer?.name ?? null,
    folders: folders ?? [],
  }
  const folder =
    stored.folder && (!folders || folders.includes(stored.folder)) ? stored.folder : null
  return {
    waiting: false,
    computerId: computer?.id ?? null,
    place: {
      computers: [here],
      remote: false,
      cloud: stored.cloud,
      chosen: folder ? { computer: here, folder } : null,
      chooseCloud: () => remember({ ...stored, cloud: true }),
      chooseFolder: (_here, folder) => remember({ cloud: false, folder }),
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

/** The folder a browser last chose, on one of the person's computers: null for the cloud. */
interface StoredOnlinePlace {
  readonly computerId: string
  readonly folder: string
}

function readStoredOnline(): StoredOnlinePlace | null {
  try {
    const stored = JSON.parse(localStorage.getItem(ONLINE_STORAGE_KEY) ?? "null") as unknown
    if (!stored || typeof stored !== "object") return null
    const { computerId, folder } = stored as Partial<StoredOnlinePlace>
    return typeof computerId === "string" && typeof folder === "string"
      ? { computerId, folder }
      : null
  } catch {
    return null
  }
}

type OnlineComputer = PlaceComputer & { readonly id: string; readonly name: string }

/**
 * In a browser: the person's computers where `sixb` is open now. A folder chosen before is the
 * place only while it's open there: what's shown is what a message is sent to, and the cloud
 * otherwise.
 */
function useOnlineComputersPlace(enabled: boolean): NewThreadPlaceState {
  const queryClient = useQueryClient()
  const listed = useQuery({ ...listAgentComputersOptions(), enabled })
  const [stored, setStored] = useState(readStoredOnline)

  const remember = useCallback((next: StoredOnlinePlace | null) => {
    setStored(next)
    try {
      localStorage.setItem(ONLINE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Private storage: the choice lasts as long as the page.
    }
  }, [])

  const chosenIn = (computers: readonly OnlineComputer[]) => {
    const computer = stored ? computers.find((known) => known.id === stored.computerId) : undefined
    return stored && computer?.folders.includes(stored.folder)
      ? { computer, folder: stored.folder }
      : null
  }

  // Before the list arrives, a message waits for it rather than going to the cloud by default.
  const resolveBody = async (): Promise<NewThreadPlaceBody> => {
    if (!enabled || !stored) return {}
    const computers = await queryClient
      .ensureQueryData(listAgentComputersOptions())
      .then(({ computers }) => computers)
      .catch(() => [])
    const chosen = chosenIn(computers)
    if (!chosen) return {}
    const { id, name } = chosen.computer
    return { runsOn: "computer", computer: { id, name, folder: chosen.folder } }
  }

  const computers = listed.data?.computers ?? []
  if (!enabled || computers.length === 0) {
    return { place: null, waiting: false, computerId: null, resolveBody }
  }

  const chosen = chosenIn(computers)
  return {
    waiting: false,
    computerId: null,
    place: {
      computers,
      remote: true,
      cloud: chosen === null,
      chosen,
      chooseCloud: () => remember(null),
      chooseFolder: (computer, folder) => {
        if (computer.id) remember({ computerId: computer.id, folder })
      },
    },
    resolveBody,
  }
}
