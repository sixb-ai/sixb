import { posix } from "node:path"

/**
 * Where a deployment lives on its server. Everything but the Bun binaries and the Caddy route
 * sits in one directory in the deploy user's home, so projects under one user never share files.
 *
 *   ~/<name>/releases/<id>  immutable release directories (code, node_modules, .sixb/dist)
 *   ~/<name>/current        symlink to the active release directory
 *   ~/<name>/code           symlink to `current` (migrated in place from single-folder deploys)
 *   ~/<name>/shared/.env    shared project `.env`, copied into each release at deploy time
 *   ~/<name>/env-token      the read-only token a deploy pulls `.env` with, if it has a source
 *   ~/<name>/deploy         lock, uploads, manifests, release record, ctl
 *   ~/<name>/run            supervisor state, control requests, and logs
 *   ~/.sixb/bun/<v>         Bun, shared by the user's projects that pin the same version
 */
export const ENV_TOKEN_FILE = "env-token"

export type DeploySlot = "blue" | "green"

export interface DeploymentLayout {
  readonly root: string
  readonly releasesDir: string
  readonly currentLink: string
  readonly code: string
  readonly sharedDir: string
  readonly sharedEnv: string
  readonly envToken: string
  readonly project: string
  readonly projectPath: string
  readonly deployDir: string
  readonly incomingDir: string
  readonly lock: string
  readonly fileList: string
  readonly manifest: string
  readonly candidateManifest: string
  readonly releaseRecord: string
  /** Runs the server half of this package with the project's Bun and manifest. */
  readonly ctl: string
  readonly runDir: string
  readonly logDir: string
  readonly bunDir: string
  readonly bun: string
  readonly unitName: string
  readonly unit: string
  readonly caddyDir: string
  readonly caddySnippet: string
}

export interface ReleaseLayout {
  readonly id: string
  readonly root: string
  readonly project: string
}

export function deploymentLayout(input: {
  readonly home: string
  readonly user: string
  readonly name: string
  readonly projectPath: string
  readonly bunVersion: string
}): DeploymentLayout {
  const root = posix.join(input.home, input.name)
  const releasesDir = posix.join(root, "releases")
  const currentLink = posix.join(root, "current")
  const code = posix.join(root, "code")
  const sharedDir = posix.join(root, "shared")
  const deployDir = posix.join(root, "deploy")
  const runDir = posix.join(root, "run")
  const bunDir = posix.join(input.home, ".sixb", "bun", input.bunVersion)
  const unitName = `sixb-${input.name}.service`
  const caddyDir = posix.join("/etc/caddy/sixb.d", input.user)

  return {
    root,
    releasesDir,
    currentLink,
    code,
    sharedDir,
    sharedEnv: posix.join(sharedDir, ".env"),
    envToken: posix.join(root, ENV_TOKEN_FILE),
    project: posix.join(code, input.projectPath),
    projectPath: input.projectPath,
    deployDir,
    incomingDir: posix.join(deployDir, "incoming"),
    lock: posix.join(deployDir, "lock"),
    fileList: posix.join(deployDir, "files.txt"),
    manifest: posix.join(deployDir, "processes.json"),
    candidateManifest: posix.join(deployDir, "candidate.json"),
    releaseRecord: posix.join(deployDir, "release.json"),
    ctl: posix.join(deployDir, "ctl"),
    runDir,
    logDir: posix.join(runDir, "logs"),
    bunDir,
    bun: posix.join(bunDir, "bun"),
    unitName,
    unit: posix.join(input.home, ".config", "systemd", "user", unitName),
    caddyDir,
    caddySnippet: posix.join(caddyDir, `${input.name}.caddy`),
  }
}

export function releaseLayout(layout: DeploymentLayout, releaseId: string): ReleaseLayout {
  const root = posix.join(layout.releasesDir, releaseId)
  return {
    id: releaseId,
    root,
    project: posix.join(root, layout.projectPath),
  }
}
