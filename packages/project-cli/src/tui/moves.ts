import type { GetAgentThreadResponses, ListAgentThreadRunsResponses } from "@sixb/client"
import { computerName, computerNameInText } from "./settings"

// Where each turn ran, and the moves between them, by the rule the app's transcript follows
// (`packages/app/src/agent/moves.ts`) and the core tells the model by (`detectMovedMessages`). The
// app's helper is not on a surface the CLI imports: it belongs to the web chat, with its catalog
// of strings and its components. This keeps the same rule on every case (retries, a round trip
// with no turn, forks, a participant, a folder not shown) and the app's English words.
//
// Two differences, on purpose. This computer is named as the terminal names it everywhere ("This
// Mac"), not by its own name. And the terminal knows the names of this computer and of the one
// the conversation runs on now, not the list of every connected computer the app reads, so a move
// to another of the person's computers may read without that computer's name.

type Run = ListAgentThreadRunsResponses[200]["runs"][number]
type Thread = GetAgentThreadResponses[200]

/**
 * Where a turn runs: the cloud, or a folder on one of its owner's computers. A computer's turn
 * whose folder the reader isn't shown (someone else's conversation, or one from before folders
 * were kept) is "computer".
 */
export type TurnPlace = "cloud" | "computer" | { readonly id: string; readonly folder: string }

/** What places are named with, beyond what the runs hold. */
export interface PlaceNames {
  /** Each computer's name, by id, where the reader knows it: runs keep only the id. */
  readonly computerNames: ReadonlyMap<string, string>
  /** This computer, named as a label ("This Mac") and lowercased in a sentence ("this Mac"). */
  readonly thisComputerId: string
  /** Whose computer it is, for someone they shared it with, who isn't shown its folders. */
  readonly ownerName: string | null
}

/** The names the terminal knows: this computer's, the conversation's computer's, its owner's. */
export function placeNames(input: {
  readonly thread: Pick<Thread, "computer" | "owner" | "ownerPrincipal"> | null
  readonly computerId: string
  readonly mine: boolean
}): PlaceNames {
  const { thread, computerId, mine } = input

  const computerNames = new Map<string, string>()
  if (thread?.computer) computerNames.set(thread.computer.id, thread.computer.name)
  computerNames.set(computerId, computerName())

  const ownerName = thread && !mine ? (thread.owner.displayName ?? thread.ownerPrincipal.id) : null
  return { computerNames, thisComputerId: computerId, ownerName }
}

export function runPlace(run: Run): TurnPlace {
  if (run.runsOn !== "computer") return "cloud"
  return run.computer ?? "computer"
}

function threadPlace(thread: Pick<Thread, "runsOn" | "computer">): TurnPlace {
  if (thread.runsOn !== "computer") return "cloud"
  return thread.computer ? { id: thread.computer.id, folder: thread.computer.folder } : "computer"
}

function samePlace(a: TurnPlace, b: TurnPlace): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b
  return a.id === b.id && a.folder === b.folder
}

/** A folder by its name, as a place reads in running text. */
export function folderName(folder: string): string {
  return folder.split("/").filter(Boolean).at(-1) ?? folder
}

/** A folder's path, a home folder written `~`: for two folders whose names are alike. */
function shownFolder(folder: string): string {
  return folder.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~")
}

/** A folder by its name, on its computer when that's known. */
function folderPlace(names: PlaceNames, place: { readonly id: string; readonly folder: string }) {
  const computer =
    place.id === names.thisComputerId ? computerNameInText() : names.computerNames.get(place.id)
  const folder = folderName(place.folder)
  return computer ? `${folder} on ${computer}` : folder
}

/** A place under a turn's answer: `Cloud`, or its computer and folder. */
export function placeName(place: TurnPlace, names: PlaceNames): string {
  if (place === "cloud") return "Cloud"
  if (place === "computer") return names.ownerName ? `${names.ownerName}'s computer` : "Computer"

  const computer = names.computerNames.get(place.id) ?? "Another computer"
  return `${computer} · ${folderName(place.folder)}`
}

/** Where it went, and which files stay behind: `from` is unknown before any turn. */
export function movedLine(names: PlaceNames, from: TurnPlace | undefined, to: TurnPlace): string {
  if (to === "cloud") {
    return typeof from === "object"
      ? `Moved to the cloud. The files in ${folderName(from.folder)} stay behind.`
      : "Moved to the cloud. The computer's files stay behind."
  }

  if (to === "computer") {
    if (from !== "cloud") return "Moved to another folder. Earlier files stay where they were."

    const computer = names.ownerName ? `${names.ownerName}'s computer` : "the computer"
    return `Moved to ${computer}. The cloud's files stay behind.`
  }

  if (from === "cloud") return `Moved to ${folderPlace(names, to)}. The cloud's files stay behind.`

  // Another folder on the same computer: by their names, or their paths where the names are alike.
  if (typeof from === "object" && from.id === to.id) {
    const alike = folderName(from.folder) === folderName(to.folder)
    const shown = alike ? shownFolder : folderName
    const left = shown(from.folder)
    return `Moved from ${left} to ${shown(to.folder)}. The files in ${left} stay behind.`
  }
  return `Moved to ${folderPlace(names, to)}. Earlier files stay where they were.`
}

/** Where a fork's first turn runs: a workspace of its own, apart from its source's. */
function continuedLine(names: PlaceNames, to: TurnPlace): string {
  const files = "The original conversation's files stay with it."
  if (to === "cloud") return `Continued in the cloud. ${files}`
  if (to === "computer") {
    const computer = names.ownerName ? `${names.ownerName}'s computer` : "the computer"
    return `Continued on ${computer}. ${files}`
  }
  return `Continued in ${folderPlace(names, to)}. ${files}`
}

/**
 * Every move of the conversation, by the shown message it follows: where a turn runs elsewhere
 * than the turn before it, and where it runs now when no turn ran since it moved. Moving back
 * before a turn ran is no move: the workspace is the one the last turn worked in. A fork's first
 * turn starts in a workspace of its own.
 */
export function transcriptMoves(input: {
  readonly thread: Pick<Thread, "runsOn" | "computer" | "movedAt" | "createdAt"> | null
  /** Oldest first, a resumed turn's trigger included. */
  readonly messages: readonly {
    readonly id: string
    readonly role: "user" | "assistant"
    readonly createdAt: string
  }[]
  /** The messages the transcript draws: a move line follows one of them. */
  readonly shownIds: ReadonlySet<string>
  /** Oldest first. */
  readonly runs: readonly Run[]
  readonly names: PlaceNames
}): ReadonlyMap<string, string> {
  const { thread, messages, shownIds, runs, names } = input

  // A retried turn runs again for the same message: its latest run is where it went.
  const placeByTrigger = new Map<string, TurnPlace>()
  for (const run of runs) {
    if (run.kind === "conversation") placeByTrigger.set(run.triggerMessageId, runPlace(run))
  }

  const moves = new Map<string, string>()
  let previous: TurnPlace | undefined
  let lastShownId: string | null = null
  // A fork's copies keep the time they were written, before the fork was: they ran in its source,
  // so its first turn here starts elsewhere. A message written here with no run, such as one
  // steering a turn, decides nothing.
  let forked = false

  for (const message of messages) {
    const place = message.role === "user" ? placeByTrigger.get(message.id) : undefined
    const copied = thread !== null && message.createdAt < thread.createdAt
    if (message.role === "user" && copied && previous === undefined) forked = true

    if (place !== undefined) {
      const line =
        previous === undefined
          ? forked && continuedLine(names, place)
          : !samePlace(previous, place) && movedLine(names, previous, place)
      if (line && lastShownId !== null) moves.set(lastShownId, line)
      previous = place
    }

    if (shownIds.has(message.id)) lastShownId = message.id
  }

  if (!thread) return moves
  const current = threadPlace(thread)

  // A fork no turn ran in yet continues after its last copy. Not by `movedAt`: a fork keeps its
  // source's, which may predate some of the copies, or all of them. A conversation no turn ran in
  // yet, and no fork, starts where it is.
  if (previous === undefined) {
    if (forked && lastShownId !== null) moves.set(lastShownId, continuedLine(names, current))
    return moves
  }

  // Where it runs now, if no turn ran there since it moved: after the last message from before
  // the move.
  const movedAt = thread.movedAt
  if (movedAt === undefined || samePlace(previous, current)) return moves

  const afterId = messages
    .filter((message) => message.createdAt <= movedAt && shownIds.has(message.id))
    .at(-1)?.id
  if (afterId) moves.set(afterId, movedLine(names, previous, current))
  return moves
}

/**
 * What a move says once done, by the transcript's rule: from where its last turn ran, the latest
 * run of the latest message. Back there with no turn in between, nothing moved. `to` is the cloud,
 * or the folder this `sixb` is open in.
 */
export function movedNotice(names: PlaceNames, runs: readonly Run[], to: TurnPlace): string {
  const destination = to === "cloud" ? "the cloud" : "this folder"
  const lastRun = [...runs].reverse().find((run) => run.kind === "conversation")

  if (!lastRun) return `Moved to ${destination}.`
  if (samePlace(runPlace(lastRun), to)) {
    return `Back in ${destination}. Nothing moved since its last reply.`
  }
  return movedLine(names, runPlace(lastRun), to)
}
