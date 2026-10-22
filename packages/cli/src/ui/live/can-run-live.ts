/**
 * A live screen needs both ends of a terminal; a pipe, a CI log, or a dumb terminal gets lines.
 * Kept apart from `./session` so asking does not load the renderer.
 */
export function canRunLive(): boolean {
  return Boolean(
    process.stdin.isTTY && process.stdout.isTTY && !process.env.CI && process.env.TERM !== "dumb"
  )
}
