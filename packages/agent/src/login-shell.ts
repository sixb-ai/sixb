import { posix } from "node:path"

/**
 * The environment variable a script travels in to its shell, never an argument. `pkill -f` and
 * `pgrep -f` match a process's arguments: as one, a command such as `pkill -f "sixb dev"; …`
 * matched its own shell and stopped itself. As one, a script that starts with `-` was also read as
 * bash's own options.
 */
export const SCRIPT_VARIABLE = "SIXB_SCRIPT"

/**
 * Runs the script, un-exported first so that the commands it starts never inherit it. A sandbox
 * that dropped the environment fails the command ("SIXB_SCRIPT: parameter not set") instead of
 * running nothing. Every word here is in the shell's arguments, so it holds no others.
 */
const RUN_SCRIPT = `export -n ${SCRIPT_VARIABLE}; eval -- "\${${SCRIPT_VARIABLE}?}"`

/**
 * Runs the script in {@link SCRIPT_VARIABLE} in a bash that is not a login shell, once a login
 * shell has loaded the profile: the profile's exports reach the script, and its `exit` leaves the
 * login shell alone.
 *
 * A login shell runs `~/.bash_logout` when the `exit` builtin ends it, with the script's options
 * still set. Debian's and Ubuntu's default one runs `clear_console`, which fails without a
 * terminal, so a script under `set -e` that ends with `exit 0` exits 1. `exec` replaces the login
 * shell without running that file, and keeps its pid, so a background command's `$!` and process
 * group are still the script's.
 */
export const LOGIN_SHELL_SCRIPT = `exec "$BASH" -c '${RUN_SCRIPT}' bash`

/**
 * {@link LOGIN_SHELL_SCRIPT}, in a directory the shell changes to itself. A directory that does not
 * exist fails the command with bash's own message, which the model can read and correct. Given
 * to the provider instead, a missing one fails the call itself, not the command. Falling off the
 * end, unlike `exit`, does not run `~/.bash_logout`.
 *
 * Arguments: the directory.
 */
export const LOGIN_SHELL_SCRIPT_IN_DIRECTORY = `cd -- "$1" && exec "$BASH" -c '${RUN_SCRIPT}' bash`

/**
 * {@link LOGIN_SHELL_SCRIPT_IN_DIRECTORY} for a background command, whose stop sends SIGTERM to
 * its whole group. `eval` keeps the shell as the command's parent, and bash defers a trapped
 * signal until the command it waits for ends: the shell then exits with the command's own code,
 * so a server that drains on SIGTERM ends as it chose, not with the shell's 143.
 */
export const BACKGROUND_SHELL_SCRIPT_IN_DIRECTORY = `cd -- "$1" && exec "$BASH" -c 'trap exit TERM; ${RUN_SCRIPT}' bash`

/** What `runCommand("bash", …)` takes to run a script as {@link LOGIN_SHELL_SCRIPT} does. */
export interface LoginShellCommand {
  readonly args: string[]
  /** The command's environment, with the script. */
  readonly env: Readonly<Record<string, string>>
}

/** Run `script` as {@link LOGIN_SHELL_SCRIPT} does, in `directory` if given, with `env`. */
export function loginShell(
  script: string,
  options: {
    readonly directory?: string | undefined
    readonly env?: Readonly<Record<string, string>> | undefined
  } = {}
): LoginShellCommand {
  const { directory, env } = options
  return {
    args:
      directory === undefined
        ? ["-lc", LOGIN_SHELL_SCRIPT, "bash"]
        : ["-lc", LOGIN_SHELL_SCRIPT_IN_DIRECTORY, "bash", directory],
    env: { ...env, [SCRIPT_VARIABLE]: script },
  }
}

/**
 * The absolute directory a command's `cwd` names, for the shell to change to. A relative one
 * resolves against the sandbox's working directory, as the bash tool describes it: in a workspace
 * cloned from Git, that is the checkout, not the provider's own directory above it. A model's
 * `cwd` never reaches the provider: see {@link LOGIN_SHELL_SCRIPT_IN_DIRECTORY}.
 */
export function commandDirectory(
  workingDirectory: string,
  cwd: string | undefined
): string | undefined {
  return cwd === undefined ? undefined : posix.resolve(workingDirectory, cwd)
}
