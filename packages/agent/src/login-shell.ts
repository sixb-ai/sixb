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

/** `bash` arguments that run `script` as {@link LOGIN_SHELL_SCRIPT} does. */
export function loginShellArgs(script: string): string[] {
  return ["-lc", LOGIN_SHELL_SCRIPT, "bash", script]
}
