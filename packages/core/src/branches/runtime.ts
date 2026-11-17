import type { BranchError, BranchState } from "../storage/branches"

/**
 * How the project reaches a branch's runtime: `sixb dev --branch` behind a front that answers on
 * one port, whatever state the project is in, and only requests that carry the branch's key.
 */

/** The key a branch runtime asks every request for, in its environment. */
export const BRANCH_KEY_ENV = "SIXB_BRANCH_KEY"

/** The header the project sends the key in. */
export const BRANCH_KEY_HEADER = "x-sixb-branch-key"

/** Where the front answers with {@link BranchRuntimeStatus}. */
export const BRANCH_STATUS_PATH = "/__sixb/branch"

/** What a branch runtime serves right now: the generation its front last started. */
export interface BranchRuntimeStatus {
  readonly branch: string
  /** Counts restarts: every change that reaches the checkout starts a new generation. */
  readonly generation: number
  readonly state: Exclude<BranchState, "stopped">
  /** The checkout's commit when the generation started. */
  readonly commit: string | null
  /** The generation's definitions manifest hash, once it serves. */
  readonly manifest: string | null
  readonly error: BranchError | null
}

/**
 * Starts the project's own `sixb` as the branch's runtime, from the project's folder, its log in
 * `.sixb/branch.log`. The branch, port and key arrive in the environment, never in the command.
 */
export const BRANCH_RUNTIME_COMMAND = [
  "mkdir -p .sixb",
  'root="$(git rev-parse --show-toplevel)"',
  'PATH="$PWD/node_modules/.bin:$root/node_modules/.bin:$PATH"',
  'exec sixb dev --branch "$SIXB_BRANCH_NAME" --port "$SIXB_BRANCH_PORT" --host 0.0.0.0 >> .sixb/branch.log 2>&1',
].join("; ")

/** Reads a front's answer, or `null` when it isn't one. */
export function parseBranchRuntimeStatus(value: unknown): BranchRuntimeStatus | null {
  if (typeof value !== "object" || value === null) return null
  const status = value as Record<string, unknown>
  if (status.state !== "starting" && status.state !== "ready" && status.state !== "failed") {
    return null
  }
  const error = status.error as Record<string, unknown> | null
  return {
    branch: String(status.branch),
    generation: Number(status.generation),
    state: status.state,
    commit: typeof status.commit === "string" ? status.commit : null,
    manifest: typeof status.manifest === "string" ? status.manifest : null,
    error:
      error && typeof error.message === "string"
        ? {
            message: error.message,
            ...(typeof error.file === "string" ? { file: error.file } : {}),
          }
        : null,
  }
}
