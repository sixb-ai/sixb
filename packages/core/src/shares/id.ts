const SHARE_TYPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** ShareType IDs are embedded as one static shared-page route and filesystem segment. */
export function isRouteSafeShareTypeId(value: unknown): value is string {
  return typeof value === "string" && SHARE_TYPE_ID_PATTERN.test(value)
}

export const SHARE_TYPE_ID_REQUIREMENT =
  "must be route-safe: start with an ASCII letter or number and contain only letters, numbers, '.', '_' or '-'"
