import {
  GUEST_COMMAND_UID,
  type GuestCommand,
  SandboxError,
  unprivilegedGuestArgv,
} from "@sixb/core/sandboxes"

// A boxd machine runs the provider's commands as its default user, which has passwordless sudo.
// The sandbox's commands never run as that user: each goes through sudo to setpriv, which drops
// to GUEST_COMMAND_UID with no groups, no capabilities and no way back to root. What only root
// or the default user can read is out of their reach: the credentials the guest's forwarder
// holds, and the staging directories the provider uploads through.

/** Where the provider keeps its guest state. */
export const GUEST_PATHS = {
  /** HOME for commands, owned by the command user and outside the working directory. */
  home: "/var/lib/sixb-home",
  /** Files bound for the workspace, readable by the command user who copies them in. */
  files: "/var/lib/sixb-files",
  /** Credentials on their way to the forwarder's root-only state: the default user's alone. */
  staging: "/var/lib/sixb-staging",
  /** The image's Node, when the command user can't reach where it is installed. */
  node: "/var/lib/sixb-node",
} as const

export const DEFAULT_WORKING_DIRECTORY = "/workspace"

const GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
/** Commands find the image's Node first where bootstrap linked it. */
const COMMAND_PATH = `${GUEST_PATHS.node}/bin:${GUEST_PATH}`

/** The bootstrap's exit status when the default user can't sudo without a password. */
export const BOOTSTRAP_NO_SUDO = 20
/** The bootstrap's exit status when the image has no `setpriv`. */
export const BOOTSTRAP_NO_SETPRIV = 21

/** Single-quote a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function line(words: readonly string[]): string {
  return words.map(shellQuote).join(" ")
}

const BOOTSTRAP_SCRIPT = `set -eu
command -v setpriv >/dev/null 2>&1 || exit ${BOOTSTRAP_NO_SETPRIV}
sudo -n true 2>/dev/null || exit ${BOOTSTRAP_NO_SUDO}
user="$(id -u)"
group="$(id -g)"
sudo -n mkdir -p -- "$1"
sudo -n chown ${GUEST_COMMAND_UID}:${GUEST_COMMAND_UID} -- "$1"
sudo -n install -d -o ${GUEST_COMMAND_UID} -g ${GUEST_COMMAND_UID} -m 700 -- "$2"
sudo -n install -d -o "$user" -g "$group" -m 711 -- "$3"
sudo -n install -d -o "$user" -g "$group" -m 700 -- "$4"
# A Node the command user can't reach, such as one under the default user's home, is linked
# into a path it can: same files, no copy where the filesystem allows hard links.
node="$(command -v node || true)"
if [ -n "$node" ] && ! sudo -n setpriv --reuid=${GUEST_COMMAND_UID} --regid=${GUEST_COMMAND_UID} --clear-groups -- test -x "$node"; then
  prefix="$(dirname -- "$(dirname -- "$(readlink -f -- "$node")")")"
  sudo -n rm -rf -- "$5"
  sudo -n cp -al -- "$prefix" "$5" 2>/dev/null || sudo -n cp -a -- "$prefix" "$5"
fi`

/** Prepare a new machine: the working directory and HOME for commands, and the staging areas. */
export function bootstrapCommand(workingDirectory: string): string {
  return line([
    "/bin/sh",
    "-c",
    BOOTSTRAP_SCRIPT,
    "sh",
    workingDirectory,
    GUEST_PATHS.home,
    GUEST_PATHS.files,
    GUEST_PATHS.staging,
    GUEST_PATHS.node,
  ])
}

// Change directory as the command user, so a directory only it can enter still works, and name a
// missing one instead of the program.
const COMMAND_SCRIPT = `cd -- "$1" 2>/dev/null || {
  printf "[Sandbox] working directory '%s' does not exist or is not a directory\\n" "$1" >&2
  exit 1
}
shift
exec "$@"`

/**
 * Run `command` as the command user in `cwd`, with exactly `env` on top of a fixed base: nothing
 * of the default user's environment reaches it.
 */
export function unprivilegedCommand(
  cwd: string,
  env: Readonly<Record<string, string>>,
  command: string,
  args: readonly string[]
): string {
  return line([
    "sudo",
    "-n",
    ...commandEnv(env),
    ...unprivilegedGuestArgv("/bin/sh", ["-c", COMMAND_SCRIPT, "sh", cwd, command, ...args]),
  ])
}

const WRITE_SCRIPT = `set -e
while [ "$#" -gt 0 ]; do
  mkdir -p -- "$(dirname -- "$2")"
  cp -- "$1" "$2"
  if [ -n "$3" ]; then chmod "$3" -- "$2"; fi
  shift 3
done`

export interface StagedFile {
  /** Where the bytes were uploaded, under {@link GUEST_PATHS.files}. */
  readonly staged: string
  /** The absolute path the file goes to. */
  readonly path: string
  readonly mode?: number
}

/**
 * Copy staged uploads into place as the command user: a link a command planted can lead a write
 * only where the command could write itself. The staged copies go either way.
 */
export function placeFilesCommand(files: readonly StagedFile[]): string {
  const place = line([
    "sudo",
    "-n",
    ...commandEnv({}),
    ...unprivilegedGuestArgv("/bin/sh", [
      "-c",
      WRITE_SCRIPT,
      "sh",
      ...files.flatMap((file) => [
        file.staged,
        file.path,
        file.mode === undefined ? "" : file.mode.toString(8),
      ]),
    ]),
  ])
  return `${place}; status=$?; rm -f -- ${line(files.map((file) => file.staged))}; exit "$status"`
}

/**
 * Move staged credential files into the forwarder's root-only state. Their contents travel only
 * through the upload, never in a command's text, which any process can read.
 */
export function placeCredentialsCommand(
  state: string,
  files: readonly { readonly staged: string; readonly path: string; readonly mode: number }[]
): string {
  const staged = line(files.map((file) => file.staged))
  return [
    `trap 'rm -f -- ${staged.replaceAll("'", "'\\''")}' EXIT`,
    "set -e",
    `sudo -n install -d -m 700 -o root -g root -- ${shellQuote(state)}`,
    ...files.map(
      (file) =>
        `sudo -n install -m ${file.mode.toString(8)} -o root -g root -- ${shellQuote(file.staged)} ${shellQuote(file.path)}`
    ),
  ].join("\n")
}

/** Run a guest credentials step as root, with a fixed environment and none of `omitted`. */
export function rootCommand(command: GuestCommand, omitted: readonly string[] = []): string {
  const env = Object.entries(command.env)
    .filter(([key]) => !omitted.includes(key))
    .map(([key, value]) => `${key}=${value}`)
  return line(["sudo", "-n", "/usr/bin/env", "-i", `PATH=${GUEST_PATH}`, ...env, ...command.argv])
}

/** Start the forwarder as root in a session of its own, so it outlives this exec. */
export function detachedRootCommand(command: GuestCommand): string {
  return `${line([
    "sudo",
    "-n",
    "setsid",
    "-f",
    "/usr/bin/env",
    "-i",
    `PATH=${GUEST_PATH}`,
    ...Object.entries(command.env).map(([key, value]) => `${key}=${value}`),
    ...command.argv,
  ])} </dev/null >/dev/null 2>&1`
}

function commandEnv(env: Readonly<Record<string, string>>): string[] {
  return [
    "/usr/bin/env",
    "-i",
    `PATH=${COMMAND_PATH}`,
    `HOME=${GUEST_PATHS.home}`,
    "LANG=C.UTF-8",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
  ]
}

/** Env names and values the guest's `env` can pass on: a name without "=", no NUL anywhere. */
export function assertGuestEnv(env: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new SandboxError(
        `[Sandbox] boxd env names must be non-empty without "=" or NUL, and values strings without NUL: ${JSON.stringify(key)}.`
      )
    }
  }
}
