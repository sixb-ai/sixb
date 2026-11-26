/**
 * A copy holds a consistent read open in production: a few at a time, one per person, whether a
 * laptop asked for it or production's branch worker takes it. Counted in this process: each
 * process of a project keeps its own count.
 */
const MAX_COPIES_PER_PROJECT = 2

/** The people copying to a branch, per project. */
const copiesRunning = new Map<string, Set<string>>()

/** A place for one person's copy, freed once, or why there is none: theirs runs, or two do. */
export function takeBranchCopySlot(
  projectId: string,
  personId: string
):
  | { readonly release: () => void }
  | { readonly refused: "person" | "project"; readonly running: number } {
  const running = copiesRunning.get(projectId) ?? new Set<string>()
  if (running.has(personId)) return { refused: "person", running: running.size }
  if (running.size >= MAX_COPIES_PER_PROJECT) return { refused: "project", running: running.size }

  running.add(personId)
  copiesRunning.set(projectId, running)
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      running.delete(personId)
      if (running.size === 0 && copiesRunning.get(projectId) === running) {
        copiesRunning.delete(projectId)
      }
    },
  }
}
