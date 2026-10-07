import type { DeployCommand, DeployRecord, DeployRelease } from "@sixb/core/deploy"
import type { DeploymentLayout } from "./layout"
import { renderCaddySnippet, renderCtl, renderProcessManifest, renderUnit } from "./render"
import { shellQuote, writeFileCommand } from "./shell"

/** A line the deploy script prints around each step; the target turns it into progress. */
export const STEP_MARKER = "__SIXB_STEP__"

/** The server's home directory, and a fresh directory to upload the source into. */
export function renderPrepareScript(name: string, commit: string): string {
  return [
    `root="$HOME"/${shellQuote(name)}`,
    'mkdir -p "$root/deploy/incoming"',
    `incoming="$(mktemp -d "$root/deploy/incoming/${commit.slice(0, 12)}.XXXXXX")"`,
    // `mktemp` makes it 0700, and GNU tar passes the mode of the upload's `.` on to `code/`, which
    // would lock out the admin, who reads the code through the deploy user's group.
    'chmod 755 "$incoming"',
    `printf '%s\\n%s\\n' "$HOME" "$incoming"`,
  ].join("\n")
}

/** Extracts one uploaded archive from standard input. */
export function renderReceiveScript(incoming: string, path: string): string {
  const directory = path === "." ? incoming : `${incoming}/${path}`
  return `mkdir -p ${shellQuote(directory)} && tar -x -f - -C ${shellQuote(directory)}`
}

export interface DeployScriptInput {
  readonly release: DeployRelease
  readonly layout: DeploymentLayout
  readonly incoming: string
  readonly record: DeployRecord
}

export interface DeployScript {
  readonly labels: readonly string[]
  readonly script: string
}

interface Step {
  readonly label: string
  readonly body: string
}

/**
 * Everything the server does once the source is uploaded, as one script that holds the
 * deployment's lock throughout. It runs with standard input closed: bash reads the whole `main`
 * function before running any of it, so no command can swallow the rest of the script.
 */
export function renderDeployScript(input: DeployScriptInput): DeployScript {
  const { release, layout } = input
  const api = release.services.find((service) => service.http?.readinessPath)
  const steps: Step[] = [
    { label: "Apply files", body: renderApplyFiles(layout, input.incoming) },
    { label: `Install Bun ${release.bunVersion}`, body: renderInstallBun(release.bunVersion) },
    { label: "Install dependencies", body: renderInstallDependencies() },
    ...release.steps.build.map((command) => runStep(command)),
    // Everything that can be rejected happens while the previous release still serves: services
    // are down only from here to "Start services".
    { label: "Write services", body: renderWriteServices(release, layout) },
    { label: "Update routes", body: renderUpdateRoutes(release, layout) },
    { label: "Stop services", body: renderStopServices() },
    ...release.steps.beforeStart.map((command) => runStep(command)),
    { label: "Start services", body: renderStartServices() },
    {
      label: "Check services",
      body: renderCheckServices(
        api?.http ? `http://${api.http.host}:${api.http.port}${api.http.readinessPath}` : null
      ),
    },
    {
      label: "Record release",
      body: writeFileCommand(layout.releaseRecord, `${JSON.stringify(input.record)}\n`),
    },
  ]

  const script = [
    "set -euo pipefail",
    "main() {",
    renderEnvironment(release, layout),
    renderTakeLock(layout),
    ...steps.flatMap((step, index) => [
      `printf '\\n%s\\t%s\\t%s\\n' ${STEP_MARKER} ${index} start`,
      step.body,
      `printf '%s\\t%s\\t%s\\n' ${STEP_MARKER} ${index} done`,
    ]),
    "}",
    "main </dev/null",
    "",
  ].join("\n")

  return { labels: steps.map((step) => step.label), script }
}

function renderEnvironment(release: DeployRelease, layout: DeploymentLayout): string {
  const variables: Record<string, string> = {
    ROOT: layout.root,
    CODE: layout.code,
    PROJECT: layout.project,
    DEPLOY: layout.deployDir,
    BUN: layout.bun,
    BUN_DIR: layout.bunDir,
    BUN_VERSION: release.bunVersion,
    CTL: layout.ctl,
    UNIT: layout.unitName,
    UNIT_PATH: layout.unit,
    CADDY_DIR: layout.caddyDir,
    CADDY_SNIPPET: layout.caddySnippet,
  }
  return [
    ...Object.entries(variables).map(([name, value]) => `${name}=${shellQuote(value)}`),
    // The steps run with the release's environment; the project's `.env` fills in the rest.
    ...Object.entries(release.env).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    'export PATH="$BUN_DIR:$PATH"',
    // `systemctl --user` finds the user's systemd through this; SSH sessions usually set it.
    'printenv XDG_RUNTIME_DIR > /dev/null || export XDG_RUNTIME_DIR="/run/user/$(id -u)"',
  ].join("\n")
}

function renderTakeLock(layout: DeploymentLayout): string {
  return [
    `exec 9>${shellQuote(layout.lock)}`,
    "if ! flock -n 9; then",
    '  echo "Waiting for another deploy of this project to finish…"',
    "fi",
    "if ! flock -w 600 9; then",
    '  echo "Another deploy of this project has held its lock for 10 minutes." >&2',
    "  exit 1",
    "fi",
  ].join("\n")
}

/**
 * Makes `code/` match the commit the way `git reset --hard` would: committed files replace what is
 * there, files the previous deploy brought and this one does not are removed, and everything else
 * — `.env`, `.sixb/`, `node_modules/` — stays. A committed `.env` is never copied over the
 * server's.
 */
export function renderApplyFiles(layout: DeploymentLayout, incoming: string): string {
  return [
    `incoming=${shellQuote(incoming)}`,
    `files=${shellQuote(layout.fileList)}`,
    `code=${shellQuote(layout.code)}`,
    'listed="$incoming.files"',
    '(cd "$incoming" && find . \\( -type f -o -type l \\) ! -name .env | LC_ALL=C sort) > "$listed"',
    'mkdir -p "$code"',
    'if [ -f "$files" ]; then',
    '  LC_ALL=C comm -23 "$files" "$listed" | while IFS= read -r path; do',
    '    rm -f "$code/$path"',
    '    dir="$(dirname "$code/$path")"',
    '    while [ "$dir" != "$code" ] && [ "$dir" != "$code/." ] && rmdir "$dir" 2>/dev/null; do',
    '      dir="$(dirname "$dir")"',
    "    done",
    "  done",
    "fi",
    `(cd "$incoming" && tar -c -f - --exclude=.env .) | (cd "$code" && tar -x -f -)`,
    'mv "$listed" "$files"',
    'rm -rf "$incoming"',
    // Uploads a deploy abandoned before it took the lock.
    'find "$(dirname "$incoming")" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null || true',
  ].join("\n")
}

/** Downloads the pinned Bun once per user and version, checking it against the release's sums. */
function renderInstallBun(version: string): string {
  const release = `https://github.com/oven-sh/bun/releases/download/bun-v${version}`
  return [
    'if [ ! -x "$BUN" ]; then',
    '  case "$(uname -m)" in',
    "    x86_64 | amd64) arch=x64 ;;",
    "    aarch64 | arm64) arch=aarch64 ;;",
    '    *) echo "Bun has no Linux build for $(uname -m)." >&2; exit 1 ;;',
    "  esac",
    // Bun's default x64 build needs AVX2; older CPUs take the baseline build.
    '  if [ "$arch" = x64 ] && ! grep -q avx2 /proc/cpuinfo; then arch=x64-baseline; fi',
    '  asset="bun-linux-$arch"',
    '  download="$(mktemp -d)"',
    `  curl -fsSL --retry 3 -o "$download/$asset.zip" ${shellQuote(release)}"/$asset.zip"`,
    `  curl -fsSL --retry 3 -o "$download/SHASUMS256.txt" ${shellQuote(release)}/SHASUMS256.txt`,
    '  (cd "$download" && grep " $asset.zip\\$" SHASUMS256.txt | sha256sum -c --quiet -)',
    '  unzip -q "$download/$asset.zip" -d "$download"',
    '  mkdir -p "$BUN_DIR"',
    '  mv "$download/$asset/bun" "$BUN"',
    '  rm -rf "$download"',
    "fi",
    // Dependency lifecycle scripts call `node`; with none installed, Bun runs them.
    'command -v node > /dev/null || ln -s "$BUN" "$BUN_DIR/node"',
    '"$BUN" --version',
  ].join("\n")
}

function renderInstallDependencies(): string {
  return [
    'cd "$PROJECT"',
    '"$BUN" install --frozen-lockfile',
    "for bin in sixb sixb-deploy-ssh; do",
    '  if [ ! -e "$PROJECT/node_modules/.bin/$bin" ]; then',
    '    package="@sixb/cli"; [ "$bin" = sixb ] || package="@sixb/deploy-ssh"',
    '    echo "$package is not installed. Add it to the project dependencies." >&2',
    "    exit 1",
    "  fi",
    "done",
  ].join("\n")
}

function runStep(command: DeployCommand): Step {
  const program = command.program === "sixb" ? '"$PROJECT/node_modules/.bin/sixb"' : ""
  return {
    label: [command.program, ...command.args].join(" "),
    body: [
      'cd "$PROJECT"',
      `"$BUN" ${program} ${command.args.map(shellQuote).join(" ")}`.replace(/ {2,}/g, " "),
    ].join("\n"),
  }
}

function renderStopServices(): string {
  return [
    'if systemctl --user is-active --quiet "$UNIT"; then',
    '  systemctl --user stop "$UNIT"',
    "else",
    "  echo 'Services were not running.'",
    "fi",
  ].join("\n")
}

function renderWriteServices(release: DeployRelease, layout: DeploymentLayout): string {
  return [
    writeFileCommand(
      layout.manifest,
      `${JSON.stringify(renderProcessManifest(release, layout), null, 2)}\n`
    ),
    writeFileCommand(layout.ctl, renderCtl(layout)),
    'chmod 755 "$CTL"',
    'mkdir -p "$(dirname "$UNIT_PATH")"',
    writeFileCommand(`${layout.unit}.new`, renderUnit(release, layout)),
    'if cmp -s "$UNIT_PATH.new" "$UNIT_PATH"; then',
    '  rm -f "$UNIT_PATH.new"',
    "else",
    '  mv "$UNIT_PATH.new" "$UNIT_PATH"',
    "  systemctl --user daemon-reload",
    '  systemctl --user enable "$UNIT"',
    "fi",
  ].join("\n")
}

/**
 * Installs the deployment's Caddy routes when they changed. Caddy has to accept the whole
 * configuration before it reloads; otherwise the previous routes come back and the deploy stops.
 */
function renderUpdateRoutes(release: DeployRelease, layout: DeploymentLayout): string {
  return [
    `new=${shellQuote(`${layout.deployDir}/Caddyfile`)}`,
    writeFileCommand(`${layout.deployDir}/Caddyfile`, renderCaddySnippet(release)),
    'if cmp -s "$new" "$CADDY_SNIPPET"; then',
    "  echo 'Routes unchanged.'",
    "else",
    '  if [ ! -w "$CADDY_DIR" ]; then',
    '    echo "$CADDY_DIR is missing or not writable, so this server is not set up for sixb deploy." >&2',
    "    exit 1",
    "  fi",
    '  previous="$DEPLOY/Caddyfile.previous"',
    '  rm -f "$previous"',
    '  if [ -f "$CADDY_SNIPPET" ]; then cp "$CADDY_SNIPPET" "$previous"; fi',
    '  cp "$new" "$CADDY_SNIPPET"',
    '  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > "$DEPLOY/caddy-validate.log" 2>&1; then',
    '    if [ -f "$previous" ]; then cp "$previous" "$CADDY_SNIPPET"; else rm -f "$CADDY_SNIPPET"; fi',
    '    tail -n 20 "$DEPLOY/caddy-validate.log" >&2',
    "    echo 'Caddy rejected the routes; the previous ones are back in place.' >&2",
    "    exit 1",
    "  fi",
    "  sudo -n /usr/bin/systemctl reload caddy",
    "fi",
  ].join("\n")
}

function renderStartServices(): string {
  return ['systemctl --user restart "$UNIT"', 'systemctl --user is-active --quiet "$UNIT"'].join(
    "\n"
  )
}

/**
 * Done means healthy, not just started: the API answers its readiness route, and no process has
 * exited in the seconds after it did.
 */
export function renderCheckServices(readinessUrl: string | null): string {
  const waitForApi = readinessUrl
    ? [
        `ready_url=${shellQuote(readinessUrl)}`,
        "ready=0",
        "for attempt in $(seq 1 90); do",
        `  if "$BUN" -e 'const r = await fetch(process.argv[1]).catch(() => null); process.exit(r?.ok ? 0 : 1)' "$ready_url" 2>/dev/null; then`,
        "    ready=1",
        "    break",
        "  fi",
        "  sleep 1",
        "done",
        'if [ "$ready" != 1 ]; then',
        '  echo "The API did not answer $ready_url within 90 seconds. Its latest log lines:" >&2',
        '  "$CTL" logs api --tail 30 >&2 || true',
        "  exit 1",
        "fi",
      ]
    : []
  return [...waitForApi, "sleep 5", '"$CTL" status --check'].join("\n")
}
