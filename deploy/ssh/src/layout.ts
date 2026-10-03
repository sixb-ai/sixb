import { posix } from "node:path"

/**
 * Where a deployment lives on its server. Everything but the Bun binaries and the Caddy route
 * sits in one directory in the deploy user's home, so projects under one user never share files.
 *
 *   ~/<name>/code      the deployed commit; the project is `code/<projectPath>`
 *   ~/<name>/deploy    lock, uploads, file list, release record, process manifest, ctl
 *   ~/<name>/run       supervisor state, control requests, and logs
 *   ~/.sixb/bun/<v>    Bun, shared by the user's projects that pin the same version
 */
export interface DeploymentLayout {
  readonly root: string
  readonly code: string
  readonly project: string
  readonly deployDir: string
  readonly incomingDir: string
  readonly lock: string
  readonly fileList: string
  readonly manifest: string
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

export function deploymentLayout(input: {
  readonly home: string
  readonly user: string
  readonly name: string
  readonly projectPath: string
  readonly bunVersion: string
}): DeploymentLayout {
  const root = posix.join(input.home, input.name)
  const code = posix.join(root, "code")
  const deployDir = posix.join(root, "deploy")
  const runDir = posix.join(root, "run")
  const bunDir = posix.join(input.home, ".sixb", "bun", input.bunVersion)
  const unitName = `sixb-${input.name}.service`
  const caddyDir = posix.join("/etc/caddy/sixb.d", input.user)

  return {
    root,
    code,
    project: posix.join(code, input.projectPath),
    deployDir,
    incomingDir: posix.join(deployDir, "incoming"),
    lock: posix.join(deployDir, "lock"),
    fileList: posix.join(deployDir, "files.txt"),
    manifest: posix.join(deployDir, "processes.json"),
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
