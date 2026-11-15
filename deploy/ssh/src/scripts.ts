import type {
  DeployCommand,
  DeployHttpServiceName,
  DeployRecord,
  DeployRelease,
} from "@sixb/core/deploy"
import { type DeploymentLayout, type ReleaseLayout, releaseLayout } from "./layout"
import {
  releaseForSlot,
  renderCaddySnippet,
  renderCtl,
  renderProcessManifest,
  renderUnit,
  type SlotPorts,
} from "./render"
import { shellQuote, writeFileCommand } from "./shell"

/** A line the deploy script prints around each step; the target turns it into progress. */
export const STEP_MARKER = "__SIXB_STEP__"

/** The server's home directory, and a fresh directory to upload the source into. */
export function renderPrepareScript(name: string, commit: string): string {
  return [
    `root="$HOME"/${shellQuote(name)}`,
    'mkdir -p "$root/deploy/incoming"',
    `incoming="$(mktemp -d "$root/deploy/incoming/${commit.slice(0, 12)}.XXXXXX")"`,
    // `mktemp` makes it 0700, and GNU tar passes the mode of the upload's `.` on to the release,
    // which would lock out the admin, who reads the code through the deploy user's group.
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
  readonly releaseId?: string
  readonly slotPorts?: SlotPorts
}

export interface DeployScript {
  readonly labels: readonly string[]
  readonly script: string
}

interface Step {
  readonly label: string
  readonly body: string
}

export function defaultSlotPorts(release: DeployRelease): SlotPorts {
  const portOf = (name: DeployHttpServiceName, fallback: number): number =>
    release.services.find((service) => service.name === name)?.http?.port ?? fallback
  const blueApp = portOf("app", 3001)
  const blueApi = portOf("api", 3002)
  return {
    blue: { app: blueApp, api: blueApi },
    green: {
      app: blueApp + 10 <= 65535 ? blueApp + 10 : blueApp - 10,
      api: blueApi + 10 <= 65535 ? blueApi + 10 : blueApi - 10,
    },
  }
}

export function deriveReleaseId(record: DeployRecord): string {
  const stamp = record.deployedAt.replace(/[-:.]/g, "").slice(0, 15)
  const sha = record.commit.slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, "")
  return `${stamp}Z-${sha || "release"}`
}

/**
 * Everything the server does once the source is uploaded, as one script that holds the
 * deployment's lock throughout. Every build, migration, provider check, and readiness check runs
 * against the new release directory before routes flip or the previous release retires.
 */
export function renderDeployScript(input: DeployScriptInput): DeployScript {
  const { release, layout } = input
  const releaseId = input.releaseId ?? deriveReleaseId(input.record)
  const targetRelease = releaseLayout(layout, releaseId)
  const slots = input.slotPorts ?? defaultSlotPorts(release)
  const blueRelease = releaseForSlot(release, slots.blue)
  const greenRelease = releaseForSlot(release, slots.green)

  const readinessUrl = (candidate: DeployRelease): string | null => {
    const api = candidate.services.find((service) => service.http?.readinessPath)
    return api?.http ? `http://${api.http.host}:${api.http.port}${api.http.readinessPath}` : null
  }

  const steps: Step[] = [
    {
      label: "Prepare release",
      body: renderPrepareRelease(layout, targetRelease, input.incoming),
    },
    { label: `Install Bun ${release.bunVersion}`, body: renderInstallBun(release.bunVersion) },
    { label: "Install dependencies", body: renderInstallDependencies() },
    ...(release.steps.env ? [envStep(release.steps.env, layout)] : []),
    ...release.steps.build.map((command, index, all) =>
      index === all.length - 1 ? withCarriedAssets(runStep(command)) : runStep(command)
    ),
    ...release.steps.beforeStart.map((command) => runStep(command)),
    {
      label: "Start new release",
      body: renderStartCandidate({
        layout,
        targetRelease,
        blueRelease,
        greenRelease,
        slots,
      }),
    },
    {
      label: "Check services",
      body: renderCheckServices({
        blueReadyUrl: readinessUrl(blueRelease),
        greenReadyUrl: readinessUrl(greenRelease),
      }),
    },
    {
      label: "Update routes",
      body: renderUpdateRoutes({
        layout,
        blueCaddy: renderCaddySnippet(blueRelease),
        greenCaddy: renderCaddySnippet(greenRelease),
      }),
    },
    {
      label: "Activate release",
      body: renderActivateRelease({
        release: blueRelease,
        layout,
        slots,
        record: input.record,
      }),
    },
  ]

  const script = [
    "set -euo pipefail",
    "main() {",
    renderEnvironment(release, layout, targetRelease),
    renderTakeLock(layout),
    renderCandidateTrap(),
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

function renderEnvironment(
  release: DeployRelease,
  layout: DeploymentLayout,
  targetRelease: ReleaseLayout
): string {
  const variables: Record<string, string> = {
    ROOT: layout.root,
    RELEASES_DIR: layout.releasesDir,
    CURRENT: layout.currentLink,
    CODE: layout.code,
    PROJECT: layout.project,
    SHARED_DIR: layout.sharedDir,
    SHARED_ENV: layout.sharedEnv,
    RELEASE_ID: targetRelease.id,
    RELEASE_ROOT: targetRelease.root,
    RELEASE_PROJECT: targetRelease.project,
    DEPLOY: layout.deployDir,
    MANIFEST: layout.manifest,
    CANDIDATE_MANIFEST: layout.candidateManifest,
    STATE_FILE: `${layout.runDir}/state.json`,
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
    'deploy_mode="none"',
    'target_slot="blue"',
    'prev_release=""',
  ].join("\n")
}

function renderTakeLock(layout: DeploymentLayout): string {
  return [
    `exec 9>${shellQuote(layout.lock)}`,
    "if ! flock -n 9; then",
    '  echo "Waiting for another deploy or script run of this project to finish…"',
    "fi",
    "if ! flock -w 600 9; then",
    '  echo "Another deploy or script run of this project has held its lock for 10 minutes." >&2',
    "  exit 1",
    "fi",
  ].join("\n")
}

function renderCandidateTrap(): string {
  return [
    "cleanup_candidate() {",
    "  status=$?",
    '  if [ "$status" -ne 0 ] && [ "$deploy_mode" = "staged" ]; then',
    '    "$BUN" "$RELEASE_PROJECT/node_modules/.bin/sixb-deploy-ssh" discard --manifest "$MANIFEST" > /dev/null 2>&1 || true',
    '    rm -f "$CANDIDATE_MANIFEST" "$DEPLOY/manifest.blue.json" "$DEPLOY/manifest.green.json"',
    "  fi",
    "}",
    "trap cleanup_candidate EXIT",
  ].join("\n")
}

/**
 * Unpacks the upload into an immutable `releases/<id>` directory, migrating an in-place `code/`
 * directory on upgrade and copying the server's shared `.env` into the release without ever
 * letting a committed `.env` overwrite it.
 */
export function renderPrepareRelease(
  layout: DeploymentLayout,
  targetRelease: ReleaseLayout,
  incoming: string
): string {
  return [
    `incoming=${shellQuote(incoming)}`,
    `releases_dir=${shellQuote(layout.releasesDir)}`,
    `current=${shellQuote(layout.currentLink)}`,
    `code=${shellQuote(layout.code)}`,
    `project=${shellQuote(layout.project)}`,
    `shared_dir=${shellQuote(layout.sharedDir)}`,
    `shared_env=${shellQuote(layout.sharedEnv)}`,
    `release_root=${shellQuote(targetRelease.root)}`,
    `release_project=${shellQuote(targetRelease.project)}`,
    'mkdir -p "$releases_dir" "$shared_dir"',
    // Migrate a pre-blue-green deployment whose `code/` is still a plain directory.
    'if [ -d "$code" ] && [ ! -L "$code" ]; then',
    '  if [ -f "$project/.env" ] && [ ! -f "$shared_env" ]; then',
    '    cp -pf "$project/.env" "$shared_env" && chmod 600 "$shared_env"',
    "  fi",
    '  rm -rf "$releases_dir/legacy"',
    '  mv "$code" "$releases_dir/legacy"',
    '  ln -sfn "releases/legacy" "$current"',
    '  ln -sfn "current" "$code"',
    "fi",
    // Pick up manual edits made to `~/app/code/.../.env` since the last deploy.
    'if [ -f "$project/.env" ] && { [ ! -f "$shared_env" ] || [ "$project/.env" -nt "$shared_env" ]; }; then',
    '  cp -pf "$project/.env" "$shared_env" && chmod 600 "$shared_env"',
    "fi",
    'if [ -L "$current" ]; then prev_release="$(basename "$(readlink "$current")")"; fi',
    'rm -rf "$release_root"',
    'mkdir -p "$release_root"',
    `(cd "$incoming" && tar -c -f - --exclude=.env .) | (cd "$release_root" && tar -x -f -)`,
    'chmod 755 "$release_root"',
    'mkdir -p "$release_project"',
    'if [ -f "$shared_env" ]; then',
    '  cp -pf "$shared_env" "$release_project/.env" && chmod 600 "$release_project/.env"',
    "fi",
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
    'cd "$RELEASE_PROJECT"',
    '"$BUN" install --frozen-lockfile --backend=hardlink',
    "for bin in sixb sixb-deploy-ssh; do",
    '  if [ ! -e "$RELEASE_PROJECT/node_modules/.bin/$bin" ]; then',
    '    package="@sixb/cli"; [ "$bin" = sixb ] || package="@sixb/deploy-ssh"',
    '    echo "$package is not installed. Add it to the project dependencies." >&2',
    "    exit 1",
    "  fi",
    "done",
  ].join("\n")
}

function runStep(command: DeployCommand): Step {
  const program = command.program === "sixb" ? '"$RELEASE_PROJECT/node_modules/.bin/sixb"' : ""
  return {
    label: [command.program, ...command.args].join(" "),
    body: [
      'cd "$RELEASE_PROJECT"',
      `"$BUN" ${program} ${command.args.map(shellQuote).join(" ")}`.replace(/ {2,}/g, " "),
    ].join("\n"),
  }
}

/** Pulls `.env` with the token only this step reads, and updates `shared/.env` for later deploys. */
function envStep(command: DeployCommand, layout: DeploymentLayout): Step {
  const step = runStep(command)
  return {
    ...step,
    body: [
      `${step.body} --token-file ${shellQuote(layout.envToken)}`,
      'if [ -f "$RELEASE_PROJECT/.env" ]; then',
      '  cp -pf "$RELEASE_PROJECT/.env" "$SHARED_ENV" && chmod 600 "$SHARED_ENV"',
      "fi",
    ].join("\n"),
  }
}

/**
 * Carries one generation of immutable content-hashed assets from the previous `current` build into
 * the new `.sixb/dist/app` directory so open browser tabs never 404 on lazy chunks after cutover.
 */
function withCarriedAssets(step: Step): Step {
  return {
    ...step,
    body: [
      step.body,
      'new_app="$RELEASE_PROJECT/.sixb/dist/app"',
      'old_app="$PROJECT/.sixb/dist/app"',
      'own_list="$RELEASE_PROJECT/.sixb/dist/.own-assets"',
      'old_own="$PROJECT/.sixb/dist/.own-assets"',
      'if [ -d "$new_app" ]; then',
      '  (cd "$new_app" && find . -type f | LC_ALL=C sort) > "$own_list"',
      '  if [ -d "$old_app" ]; then',
      '    source_list="$old_own"',
      '    if [ ! -f "$source_list" ]; then',
      '      source_list="$(mktemp)"',
      '      (cd "$old_app" && find . -type f | LC_ALL=C sort) > "$source_list"',
      '      temp_source_list="$source_list"',
      "    else",
      '      temp_source_list=""',
      "    fi",
      "    while IFS= read -r rel; do",
      '      base="$(basename "$rel")"',
      '      case "$base" in',
      "        chunk-* | asset-* | app-*.* | shared-app-*.* | auth-*.*)",
      '          if [ ! -e "$new_app/$rel" ] && [ -f "$old_app/$rel" ]; then',
      '            mkdir -p "$(dirname "$new_app/$rel")"',
      '            ln "$old_app/$rel" "$new_app/$rel" 2>/dev/null || cp -p "$old_app/$rel" "$new_app/$rel"',
      "          fi",
      "          ;;",
      "      esac",
      '    done < "$source_list"',
      '    if [ -n "$temp_source_list" ]; then rm -f "$temp_source_list"; fi',
      "  fi",
      "fi",
    ].join("\n"),
  }
}

function renderStartCandidate(input: {
  readonly layout: DeploymentLayout
  readonly targetRelease: ReleaseLayout
  readonly blueRelease: DeployRelease
  readonly greenRelease: DeployRelease
  readonly slots: SlotPorts
}): string {
  const { layout, targetRelease, blueRelease, greenRelease, slots } = input
  const blueManifest = renderProcessManifest(blueRelease, layout, {
    projectDir: targetRelease.project,
    slot: "blue",
  })
  const greenManifest = renderProcessManifest(greenRelease, layout, {
    projectDir: targetRelease.project,
    slot: "green",
  })
  const installServiceFiles = renderInstallServiceFiles(blueRelease, layout, slots)

  return [
    writeFileCommand(
      `${layout.deployDir}/manifest.blue.json`,
      `${JSON.stringify(blueManifest, null, 2)}\n`
    ),
    writeFileCommand(
      `${layout.deployDir}/manifest.green.json`,
      `${JSON.stringify(greenManifest, null, 2)}\n`
    ),
    'if [ -f "$MANIFEST" ] && systemctl --user is-active --quiet "$UNIT"; then',
    '  if grep -qs \'"slot": "green"\' "$MANIFEST"; then target_slot="blue"; else target_slot="green"; fi',
    '  cp "$DEPLOY/manifest.$target_slot.json" "$CANDIDATE_MANIFEST"',
    '  stage_err="$(mktemp)"',
    '  if "$BUN" "$RELEASE_PROJECT/node_modules/.bin/sixb-deploy-ssh" stage "$CANDIDATE_MANIFEST" --manifest "$MANIFEST" 2> "$stage_err"; then',
    '    rm -f "$stage_err"',
    '    deploy_mode="staged"',
    "    started=$SECONDS",
    '  elif grep -qs "Invalid supervisor request" "$stage_err"; then',
    "    # One-time upgrade from a supervisor started before blue-green staging existed.",
    '    rm -f "$stage_err"',
    '    target_slot="blue"',
    '    systemctl --user stop "$UNIT"',
    '    ln -sfn "releases/$RELEASE_ID" "$CURRENT"',
    '    ln -sfn "current" "$CODE"',
    ...installServiceFiles.map((line) => `    ${line}`),
    '    mv "$DEPLOY/manifest.blue.json" "$MANIFEST"',
    '    rm -f "$DEPLOY/manifest.green.json" "$CANDIDATE_MANIFEST"',
    '    systemctl --user restart "$UNIT"',
    '    systemctl --user is-active --quiet "$UNIT"',
    '    deploy_mode="cold"',
    "    started=$SECONDS",
    "  else",
    '    cat "$stage_err" >&2',
    '    rm -f "$stage_err"',
    "    exit 1",
    "  fi",
    "else",
    '  target_slot="blue"',
    '  ln -sfn "releases/$RELEASE_ID" "$CURRENT"',
    '  ln -sfn "current" "$CODE"',
    ...installServiceFiles.map((line) => `  ${line}`),
    '  mv "$DEPLOY/manifest.blue.json" "$MANIFEST"',
    '  rm -f "$DEPLOY/manifest.green.json" "$CANDIDATE_MANIFEST"',
    '  systemctl --user restart "$UNIT"',
    '  systemctl --user is-active --quiet "$UNIT"',
    '  deploy_mode="cold"',
    "  started=$SECONDS",
    "fi",
  ].join("\n")
}

/**
 * Done means healthy, not just started: the API answers its readiness route, and no process has
 * exited in its first seconds. Those seconds count from "Start new release", so the time the API
 * takes to boot is part of them rather than added to them.
 */
export function renderCheckServices(input: {
  readonly blueReadyUrl: string | null
  readonly greenReadyUrl?: string | null
}): string {
  const blueUrl = input.blueReadyUrl
  const greenUrl = input.greenReadyUrl ?? input.blueReadyUrl
  const waitForApi =
    blueUrl || greenUrl
      ? [
          `ready_url=${shellQuote(blueUrl ?? "")}`,
          'if [ "$target_slot" = "green" ]; then',
          `  ready_url=${shellQuote(greenUrl ?? "")}`,
          "fi",
          'if [ -n "$ready_url" ]; then',
          "  ready=0",
          "  for attempt in $(seq 1 90); do",
          `    if "$BUN" -e 'const r = await fetch(process.argv[1]).catch(() => null); process.exit(r?.ok ? 0 : 1)' "$ready_url" 2>/dev/null; then`,
          "      ready=1",
          "      break",
          "    fi",
          "    sleep 1",
          "  done",
          '  if [ "$ready" != 1 ]; then',
          '    echo "The API did not answer $ready_url within 90 seconds. Its latest log lines:" >&2',
          '    "$CTL" logs api --tail 30 >&2 || true',
          "    exit 1",
          "  fi",
          "fi",
        ]
      : []
  return [
    ...waitForApi,
    "quiet=$((5 - (SECONDS - started)))",
    'if [ "$quiet" -gt 0 ]; then sleep "$quiet"; fi',
    'if [ "$deploy_mode" = "staged" ]; then',
    '  "$BUN" "$RELEASE_PROJECT/node_modules/.bin/sixb-deploy-ssh" status --check --candidate --manifest "$MANIFEST"',
    "else",
    '  "$CTL" status --check',
    "fi",
  ].join("\n")
}

/**
 * Installs the deployment's Caddy routes for the verified slot. Caddy has to accept the whole
 * configuration before it reloads; otherwise the previous routes come back and the deploy stops.
 */
function renderUpdateRoutes(input: {
  readonly layout: DeploymentLayout
  readonly blueCaddy: string
  readonly greenCaddy: string
}): string {
  const { layout, blueCaddy, greenCaddy } = input
  return [
    writeFileCommand(`${layout.deployDir}/Caddyfile.blue`, blueCaddy),
    writeFileCommand(`${layout.deployDir}/Caddyfile.green`, greenCaddy),
    'new="$DEPLOY/Caddyfile.$target_slot"',
    'cp "$new" "$DEPLOY/Caddyfile"',
    'rm -f "$DEPLOY/Caddyfile.blue" "$DEPLOY/Caddyfile.green"',
    'if cmp -s "$DEPLOY/Caddyfile" "$CADDY_SNIPPET"; then',
    "  echo 'Routes unchanged.'",
    "else",
    '  if [ ! -w "$CADDY_DIR" ]; then',
    '    echo "$CADDY_DIR is missing or not writable, so this server is not set up for sixb deploy." >&2',
    "    exit 1",
    "  fi",
    '  previous="$DEPLOY/Caddyfile.previous"',
    '  rm -f "$previous"',
    '  if [ -f "$CADDY_SNIPPET" ]; then cp "$CADDY_SNIPPET" "$previous"; fi',
    '  cp "$DEPLOY/Caddyfile" "$CADDY_SNIPPET"',
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

function renderInstallServiceFiles(
  release: DeployRelease,
  layout: DeploymentLayout,
  slots: SlotPorts
): string[] {
  const reservedPorts = [
    ...new Set(
      release.services.flatMap((service) =>
        service.http && (service.name === "api" || service.name === "app")
          ? [slots.blue[service.name], slots.green[service.name]]
          : []
      )
    ),
  ]
    .map(String)
    .join("\n")

  return [
    writeFileCommand(`${layout.deployDir}/ports.txt`, reservedPorts ? `${reservedPorts}\n` : ""),
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
  ]
}

function renderActivateRelease(input: {
  readonly release: DeployRelease
  readonly layout: DeploymentLayout
  readonly slots: SlotPorts
  readonly record: DeployRecord
}): string {
  const hasExclusiveServices = input.release.services.some(
    (service) => service.kind === "singleton" || service.kind === "script"
  )
  const installServiceFiles = renderInstallServiceFiles(input.release, input.layout, input.slots)
  return [
    'if [ "$deploy_mode" = "staged" ]; then',
    '  ln -sfn "releases/$RELEASE_ID" "$CURRENT"',
    '  ln -sfn "current" "$CODE"',
    ...installServiceFiles.map((line) => `  ${line}`),
    '  mv "$CANDIDATE_MANIFEST" "$MANIFEST"',
    '  rm -f "$DEPLOY/manifest.blue.json" "$DEPLOY/manifest.green.json"',
    '  deploy_mode="activated"',
    '  "$CTL" activate',
    ...(hasExclusiveServices ? ["  sleep 2"] : []),
    '  "$CTL" status --check',
    "fi",
    writeFileCommand(input.layout.releaseRecord, `${JSON.stringify(input.record)}\n`),
    renderPruneReleases(),
  ].join("\n")
}

/** Keeps the active release, the previous release, and any release still draining in `state.json`. */
export function renderPruneReleases(): string {
  return [
    'if [ -d "$RELEASES_DIR" ]; then',
    '  for candidate_dir in "$RELEASES_DIR"/*; do',
    '    [ -d "$candidate_dir" ] || continue',
    '    name="$(basename "$candidate_dir")"',
    '    if [ "$name" = "$RELEASE_ID" ] || [ "$name" = "$prev_release" ]; then continue; fi',
    '    if [ -f "$STATE_FILE" ] && grep -qsF "$candidate_dir" "$STATE_FILE"; then continue; fi',
    '    rm -rf "$candidate_dir"',
    "  done",
    "fi",
  ].join("\n")
}
