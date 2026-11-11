/** The longest script path an execution records, so a stored source stays a short label. */
const MAX_SCRIPT_PATH_LENGTH = 1_024

/**
 * A script execution names its file by a path relative to the project, with forward slashes: what
 * a reader of the record can find in the repository.
 */
export function isScriptPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path !== "" &&
    path.trim() === path &&
    path.length <= MAX_SCRIPT_PATH_LENGTH &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  )
}

export function assertScriptPath(path: unknown): asserts path is string {
  if (!isScriptPath(path)) {
    throw new Error(
      `[Sixb] Script path '${String(path)}' must be relative to the project, such as 'scripts/fix.ts'.`
    )
  }
}
