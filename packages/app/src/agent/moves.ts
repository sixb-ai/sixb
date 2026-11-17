import { folderName, shownFolder } from "./components/computer-place"
import type { AgentMessages } from "./i18n"
import type { AgentMessage, AgentRun, AgentThread } from "./types"

/**
 * Where a turn runs: the cloud, or a folder on one of its owner's computers. A computer's turn whose
 * folder the reader isn't shown (someone else's conversation, or one from before folders were kept)
 * is "a computer". The same places as the core's `runPlaceKey`, which tells the model of each move.
 */
type Place = "cloud" | "computer" | { readonly id: string; readonly folder: string }

function placeKey(place: Place): string {
  return typeof place === "string" ? place : `computer:${place.id}:${place.folder}`
}

function samePlace(a: Place, b: Place): boolean {
  return placeKey(a) === placeKey(b)
}

function runPlace(run: AgentRun): Place {
  if (run.runsOn !== "computer") return "cloud"
  return run.computer ?? "computer"
}

function threadPlace(thread: AgentThread): Place {
  if (thread.runsOn !== "computer") return "cloud"
  return thread.computer ? { id: thread.computer.id, folder: thread.computer.folder } : "computer"
}

/** A move in the transcript: what it says, and where it went. */
export interface TranscriptMove {
  readonly label: string
  readonly place: "cloud" | "computer"
}

/** What the labels name places with, beyond what the runs hold. */
interface MoveNames {
  readonly messages: AgentMessages["computer"]
  /** Each computer's name, by id, where the reader knows it: runs keep only the id. */
  readonly computerNames: ReadonlyMap<string, string>
  /** Whose computer it is, for someone they shared it with, who isn't shown its folders. */
  readonly ownerName: string | null
}

/** A folder by its name, on its computer when that's known. */
function folderPlace(names: MoveNames, place: { readonly id: string; readonly folder: string }) {
  const computer = names.computerNames.get(place.id)
  const folder = folderName(place.folder)
  return computer ? names.messages.placeOn(folder, computer) : folder
}

/** Where it went, and which files stay behind: `from` is unknown before any turn. */
function movedLabel(names: MoveNames, from: Place | undefined, to: Place): TranscriptMove {
  const { messages } = names

  if (to === "cloud") {
    const left = typeof from === "object" ? folderName(from.folder) : null
    return { label: messages.movedToCloud(left), place: "cloud" }
  }

  if (to === "computer") {
    const label =
      from === "cloud" ? messages.movedToComputer(names.ownerName) : messages.movedElsewhere(null)
    return { label, place: "computer" }
  }

  if (from === "cloud") {
    return { label: messages.movedToFolder(folderPlace(names, to)), place: "computer" }
  }

  // Another folder on the same computer: by their names, or their paths where the names are alike.
  if (typeof from === "object" && from.id === to.id) {
    const alike = folderName(from.folder) === folderName(to.folder)
    const shown = alike ? shownFolder : folderName
    return {
      label: messages.movedBetweenFolders(shown(to.folder), shown(from.folder)),
      place: "computer",
    }
  }
  return { label: messages.movedElsewhere(folderPlace(names, to)), place: "computer" }
}

/** Where a fork's first turn runs: a workspace of its own, apart from its source's. */
function continuedLabel(names: MoveNames, to: Place): TranscriptMove {
  const { messages } = names
  if (to === "cloud") return { label: messages.continuedIn(messages.cloudPlace), place: "cloud" }
  if (to === "computer") {
    return { label: messages.continuedOnComputer(names.ownerName), place: "computer" }
  }
  return { label: messages.continuedIn(folderPlace(names, to)), place: "computer" }
}

export interface TranscriptMoves {
  /** The latest move, when no turn ran since: after the last message from before it. */
  readonly moved: (TranscriptMove & { readonly afterMessageId: string }) | null
  /** Every move, by the shown message it follows. */
  readonly moves: ReadonlyMap<string, TranscriptMove>
}

/**
 * Every place the conversation moved to, in its transcript: where a turn runs elsewhere than the
 * turn before it, and where it runs now when no turn ran since it moved. Moving back before a turn
 * ran is no move: the workspace is the one the last turn worked in. A fork's first turn starts in a
 * workspace of its own. The core tells the model the same (`detectMovedMessages`).
 */
export function transcriptMoves(
  input: MoveNames & {
    readonly thread: AgentThread | null
    /** Oldest first. */
    readonly savedMessages: readonly AgentMessage[]
    /** The saved messages the transcript draws: a marker follows one of them. */
    readonly shownIds: ReadonlySet<string>
    /** Newest first, as the conversation reads them. */
    readonly runs: readonly AgentRun[]
  }
): TranscriptMoves {
  const { thread, savedMessages, shownIds, runs } = input

  // A retried turn runs again for the same message: its latest run is where it went.
  const placeByTrigger = new Map<string, Place>()
  for (const run of [...runs].reverse()) {
    if (run.kind === "conversation") placeByTrigger.set(run.triggerMessageId, runPlace(run))
  }

  const moves = new Map<string, TranscriptMove>()
  let previous: Place | undefined
  let lastShownId: string | null = null
  // A fork's copies keep the time they were written, before the fork was: they ran in its source,
  // so its first turn here starts elsewhere. A message written here with no run, such as one
  // steering a turn, decides nothing.
  let forked = false

  for (const saved of savedMessages) {
    const place = saved.role === "user" ? placeByTrigger.get(saved.id) : undefined
    const copied = thread !== null && saved.createdAt < thread.createdAt
    if (saved.role === "user" && copied && previous === undefined) forked = true

    if (place !== undefined) {
      const move =
        previous === undefined
          ? forked && continuedLabel(input, place)
          : !samePlace(previous, place) && movedLabel(input, previous, place)
      if (move && lastShownId !== null) moves.set(lastShownId, move)
      previous = place
    }

    if (shownIds.has(saved.id)) lastShownId = saved.id
  }

  if (!thread) return { moved: null, moves }

  // Where it runs now, if no turn ran there yet: after the last message from before the move, or
  // a fork's last copy.
  const current = threadPlace(thread)
  const move =
    previous === undefined
      ? forked && continuedLabel(input, current)
      : thread.movedAt !== undefined &&
        !samePlace(previous, current) &&
        movedLabel(input, previous, current)
  if (!move) return { moved: null, moves }

  // A fork keeps its source's latest move, which can predate some of its copies: its marker
  // follows the last copy. A move's follows the last message from before it.
  const movedAt = previous === undefined ? undefined : thread.movedAt
  const afterMessageId = movedAt
    ? savedMessages.filter((saved) => saved.createdAt <= movedAt && shownIds.has(saved.id)).at(-1)
        ?.id
    : lastShownId
  if (!afterMessageId) return { moved: null, moves }

  moves.set(afterMessageId, move)
  return { moved: { ...move, afterMessageId }, moves }
}
