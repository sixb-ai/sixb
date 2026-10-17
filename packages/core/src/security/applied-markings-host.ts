import type { AppliedMarkings } from "./applied-markings"
import { errorMessage } from "./applied-markings-contribution"

const appliedMarkingsKey: unique symbol = Symbol("sixb.appliedMarkings")

interface AppliedMarkingsOwner {
  readonly [appliedMarkingsKey]?: AppliedMarkings
}

/** One snapshot per host, so every reader shares it and its resolved clearances. */
export function registerAppliedMarkings(owner: object, markings: AppliedMarkings): void {
  const registered = (owner as AppliedMarkingsOwner)[appliedMarkingsKey]
  if (registered && registered !== markings) {
    throw new Error("[Sixb] Applied markings are already registered for this owner.")
  }

  Object.defineProperty(owner, appliedMarkingsKey, {
    configurable: false,
    enumerable: false,
    value: markings,
    writable: false,
  })
}

export function getAppliedMarkings(owner: object): AppliedMarkings {
  const markings = (owner as AppliedMarkingsOwner)[appliedMarkingsKey]
  if (markings) return markings
  throw new Error("[Sixb] Applied markings are not registered for this runtime.")
}

/**
 * Read the applied versions ahead of the first request that needs them. A failure is only
 * reported here: that request reads them again, and fails closed if it cannot.
 */
export function warmAppliedMarkings(owner: object): void {
  getAppliedMarkings(owner)
    .current()
    .catch((error: unknown) => {
      console.warn(errorMessage(error))
    })
}
