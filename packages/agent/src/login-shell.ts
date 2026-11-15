import { posix } from "node:path"

/**
 * Runs a script in a bash that is not a login shell, once a login shell has loaded the profile:
 * the profile's exports reach the script, and its `exit` leaves the login shell alone.
 *
 * A login shell runs `~/.bash_logout` when the `exit` builtin ends it, with the script's options
 * still set. Debian's and Ubuntu's default one runs `clear_console`, which fails without a
 * terminal, so a script under `set -e` that ends with `exit 0` exits 1. `exec` replaces the login
 * shell without running that file, and keeps its pid, so a background command's `$!` and process
 * group are still the script's.
 *
 * Arguments: the script.
 */
export const LOGIN_SHELL_SCRIPT = 'exec "$BASH" -c "$1" bash'

/**
 * {@link LOGIN_SHELL_SCRIPT}, in a directory the shell changes to itself. A directory that does not
 * exist fails the command with bash's own message, which the model can read and correct. Given
 * to the sandbox instead, it would refuse to start the command, and a refused command leaves the
 * workspace unconfirmed. Falling off the end, unlike `exit`, does not run `~/.bash_logout`.
 *
 * Arguments: the directory, then the script.
 */
export const LOGIN_SHELL_SCRIPT_IN_DIRECTORY = 'cd -- "$1" && exec "$BASH" -c "$2" bash'

/** `bash` arguments that run `script` as {@link LOGIN_SHELL_SCRIPT} does, in `directory` if given. */
export function loginShellArgs(script: string, directory?: string): string[] {
  return directory === undefined
    ? ["-lc", LOGIN_SHELL_SCRIPT, "bash", script]
    : ["-lc", LOGIN_SHELL_SCRIPT_IN_DIRECTORY, "bash", directory, script]
}

/**
 * The absolute directory a command's `cwd` names, resolved as a provider resolves it, for the
 * shell to change to. A model's `cwd` never reaches the provider: see
 * {@link LOGIN_SHELL_SCRIPT_IN_DIRECTORY}.
 */
export function commandDirectory(
  workingDirectory: string,
  cwd: string | undefined
): string | undefined {
  return cwd === undefined ? undefined : posix.resolve(workingDirectory, cwd)
}
