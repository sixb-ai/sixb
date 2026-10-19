/**
 * Every change of a draft in order, so each can be undone and done again: a sheet's or a canvas's.
 * A change made after an undo drops what was undone, as an editor's does.
 */
export interface History<Draft> {
  readonly past: readonly Draft[]
  readonly present: Draft
  readonly future: readonly Draft[]
}

/** How many changes undo reaches back. */
const LIMIT = 200

export function startHistory<Draft>(present: Draft): History<Draft> {
  return { past: [], present, future: [] }
}

/** The draft after a change, which undo returns from; one that changes nothing is not kept. */
export function recordChange<Draft>(history: History<Draft>, next: Draft): History<Draft> {
  if (next === history.present) return history
  return { past: [...history.past, history.present].slice(-LIMIT), present: next, future: [] }
}

export function undoChange<Draft>(history: History<Draft>): History<Draft> {
  const previous = history.past.at(-1)
  if (previous === undefined) return history
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  }
}

export function redoChange<Draft>(history: History<Draft>): History<Draft> {
  const next = history.future[0]
  if (next === undefined) return history
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  }
}
