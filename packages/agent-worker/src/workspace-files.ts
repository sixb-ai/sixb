import type { Sandbox } from "@sixb/core"
import { bounded, SANDBOX_OPERATION_TIMEOUT_MS, sandboxError } from "./sandbox-operation"

/** The script's exit status when the repository claims the directory reserved for run files. */
const RESERVED_DIRECTORY_CLAIMED = 3

/** The checkout tracks or re-includes `.sixb/agent/`: only the repository's owner can fix it. */
export class WorkspaceRunFilesConflictError extends Error {
  readonly name = "WorkspaceRunFilesConflictError"

  constructor() {
    super(
      "[SixbAgentWorker] Sandbox repository tracks or re-includes .sixb/agent/, which Sixb reserves for run files. Remove the tracked files (git rm -r --cached .sixb/agent) and any .gitignore rule that re-includes the directory."
    )
  }
}

/** Run before materialization and before saving. Git exclusions prevent accidental staging,
 * not deliberate publication; tracked runtime files must still block cleanup.
 */
export function workspaceRunFilesScript(hasSource: boolean): string {
  const git = hasSource
    ? `
git rev-parse --git-dir >/dev/null
tracked=$(git ls-files -- .sixb/agent)
test -z "$tracked" || exit ${RESERVED_DIRECTORY_CLAIMED}
# Managed sources are ordinary clones. Never write through redirected Git metadata.
test -d .git
test ! -L .git
test ! -L .git/info
test ! -L .git/info/exclude
mkdir -p .git/info
test ! -e .git/info/exclude || test -f .git/info/exclude
excluded=false
if test -f .git/info/exclude; then
  while IFS= read -r rule || test -n "$rule"; do
    if test "$rule" = '/.sixb/agent/'; then excluded=true; break; fi
  done < .git/info/exclude
fi
if test "$excluded" = false; then
  printf '\\n/.sixb/agent/\\n' >> .git/info/exclude
fi
# Repository ignore rules take precedence over local exclusions. Fail before writing secrets
# when a repository explicitly re-includes our reserved directory; 1 means "not ignored".
ignored=0
git check-ignore -q -- .sixb/agent/ || ignored=$?
test "$ignored" -ne 1 || exit ${RESERVED_DIRECTORY_CLAIMED}
test "$ignored" -eq 0
`
    : ""
  return `set -e
test ! -L .sixb
${git}
rm -rf -- .sixb/agent`
}

/**
 * Remove only framework-owned transient files and, in a Git checkout, exclude them before any
 * run file is written. Refuse a redirected parent directory, and a repository that claims the
 * reserved directory with {@link WorkspaceRunFilesConflictError}.
 */
export async function prepareWorkspaceRunFiles(
  sandbox: Sandbox,
  hasSource: boolean
): Promise<void> {
  const result = await bounded(
    sandbox.runCommand("bash", ["-c", workspaceRunFilesScript(hasSource)], {
      timeout: SANDBOX_OPERATION_TIMEOUT_MS,
    })
  )
  if (result.timedOut) throw sandboxError("command failed.")
  if (result.exitCode === RESERVED_DIRECTORY_CLAIMED) throw new WorkspaceRunFilesConflictError()
  if (result.exitCode !== 0) throw sandboxError("command failed.")
}
