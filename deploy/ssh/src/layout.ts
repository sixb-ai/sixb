import { posix } from "node:path"
import type { DeployHttpServiceName } from "@sixb/core/deploy"

/** The account every deployment runs as. A server runs one deployment. */
export const DEPLOY_USER = "sixb"

/** The read-only token a deploy pulls `.env` with, for a project with a source. */
export const ENV_TOKEN_FILE = "env-token"

/**
 * A deployment runs in one of two slots. A release starts in the idle one, beside the live one,
 * and takes traffic once it is healthy.
 */
export type DeploySlot = "blue" | "green"

export const SLOTS: readonly DeploySlot[] = ["blue", "green"]

/** The loopback ports each slot's HTTP services listen on. Caddy forwards to the live slot's. */
export const SLOT_PORTS = {
  blue: { app: 3001, api: 3002 },
  green: { app: 3011, api: 3012 },
} as const satisfies Record<DeploySlot, Record<DeployHttpServiceName, number>>

export function otherSlot(slot: DeploySlot): DeploySlot {
  return slot === "blue" ? "green" : "blue"
}

/**
 * Where a deployment lives on its server: one folder in the deploy account's home, plus Bun, the
 * slot service and the Caddy routes.
 *
 *   ~/<name>/releases/<id>      immutable releases: code, node_modules, .sixb/dist, .env
 *   ~/<name>/current            the live release
 *   ~/<name>/code               `current`, for scripts and older tools that look here
 *   ~/<name>/shared/.env        the `.env` kept on the server, for a project without a source
 *   ~/<name>/env-token          the token a deploy pulls `.env` with, for a project with one
 *   ~/<name>/deploy/            lock, uploads, release record, live slot, slot launchers, ctl
 *   ~/<name>/run/<slot>/        each slot's supervisor state, control requests and logs
 *   ~/.sixb/bun/<version>/      Bun, shared by releases on the same version
 */
export interface DeploymentLayout {
  readonly name: string
  readonly home: string
  readonly root: string
  readonly releasesDir: string
  readonly currentLink: string
  readonly code: string
  readonly sharedEnv: string
  readonly envToken: string
  readonly deployDir: string
  readonly incomingDir: string
  readonly runsDir: string
  readonly lock: string
  readonly releaseRecord: string
  /** Names the live slot. */
  readonly liveSlotFile: string
  /** What `status`, `logs` and the other operations run: the live release's server half. */
  readonly ctl: string
  readonly unitDir: string
  /** The slot service's template, instantiated as `sixb-<name>@blue` and `sixb-<name>@green`. */
  readonly unitTemplate: string
  readonly caddyDir: string
  readonly caddySnippet: string
}

export interface SlotLayout {
  readonly slot: DeploySlot
  readonly unit: string
  readonly manifest: string
  /** What the slot's service runs: its release's supervisor, with its Bun. */
  readonly launcher: string
  readonly runDir: string
  readonly logDir: string
}

/** A deployment from before slots: one service, one manifest. Adopted by its first slot deploy. */
export interface LegacyLayout {
  readonly unit: string
  readonly unitPath: string
  readonly manifest: string
}

export function deploymentLayout(input: { readonly home: string; readonly name: string }) {
  const root = posix.join(input.home, input.name)
  const deployDir = posix.join(root, "deploy")
  const unitDir = posix.join(input.home, ".config", "systemd", "user")
  const caddyDir = posix.join("/etc/caddy/sixb.d", DEPLOY_USER)
  return {
    name: input.name,
    home: input.home,
    root,
    releasesDir: posix.join(root, "releases"),
    currentLink: posix.join(root, "current"),
    code: posix.join(root, "code"),
    sharedEnv: posix.join(root, "shared", ".env"),
    envToken: posix.join(root, ENV_TOKEN_FILE),
    deployDir,
    incomingDir: posix.join(deployDir, "incoming"),
    runsDir: posix.join(deployDir, "runs"),
    lock: posix.join(deployDir, "lock"),
    releaseRecord: posix.join(deployDir, "release.json"),
    liveSlotFile: posix.join(deployDir, "live-slot"),
    ctl: posix.join(deployDir, "ctl"),
    unitDir,
    unitTemplate: posix.join(unitDir, `sixb-${input.name}@.service`),
    caddyDir,
    caddySnippet: posix.join(caddyDir, `${input.name}.caddy`),
  } satisfies DeploymentLayout
}

export function slotLayout(layout: DeploymentLayout, slot: DeploySlot): SlotLayout {
  const runDir = posix.join(layout.root, "run", slot)
  return {
    slot,
    unit: `sixb-${layout.name}@${slot}.service`,
    manifest: posix.join(layout.deployDir, `${slot}.json`),
    launcher: posix.join(layout.deployDir, slot),
    runDir,
    logDir: posix.join(runDir, "logs"),
  }
}

export function legacyLayout(layout: DeploymentLayout): LegacyLayout {
  const unit = `sixb-${layout.name}.service`
  return {
    unit,
    unitPath: posix.join(layout.unitDir, unit),
    manifest: posix.join(layout.deployDir, "processes.json"),
  }
}

export interface ReleaseLayout {
  readonly id: string
  readonly root: string
  /** The project inside the release: its root, or a folder of a monorepo. */
  readonly project: string
  readonly bunDir: string
  readonly bun: string
}

export function releaseLayout(
  layout: DeploymentLayout,
  input: { readonly id: string; readonly projectPath: string; readonly bunVersion: string }
): ReleaseLayout {
  const root = posix.join(layout.releasesDir, input.id)
  const bunDir = posix.join(layout.home, ".sixb", "bun", input.bunVersion)
  return {
    id: input.id,
    root,
    project: posix.join(root, input.projectPath),
    bunDir,
    bun: posix.join(bunDir, "bun"),
  }
}
