import { readFile } from "node:fs/promises"
import type { SandboxNetworkTarget } from "@sixb/core"
import { loadEnvConfig } from "./env-config"
import { SixbCliError } from "./errors"

/**
 * The deployment's setting for the branch worker: a file holding a credential that reads the
 * project's `dev` values from its source, and nothing else. Without it, branches start without
 * them, and say so.
 */
export const BRANCH_DEV_ENV_TOKEN_FILE_ENV = "SIXB_BRANCH_DEV_ENV_TOKEN_FILE"

/**
 * The deployment's setting for what else a branch's sandbox may reach, beyond production's
 * PostgreSQL and API, the git host and the package registries: origins, comma-separated, such as
 * the services the project's `dev` values point at.
 */
export const BRANCH_ALLOW_ENV = "SIXB_BRANCH_ALLOW"

/** The origins `SIXB_BRANCH_ALLOW` names. */
export function branchAllowedTargets(
  value: string | undefined = process.env[BRANCH_ALLOW_ENV]
): SandboxNetworkTarget[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return { name: new URL(origin).host, origin: new URL(origin).origin }
      } catch {
        throw new SixbCliError(
          `[SixbWorker] ${BRANCH_ALLOW_ENV} holds '${origin}', which is no origin.`
        )
      }
    })
}

/**
 * The project's `dev` values for each branch the worker starts, read through the source its
 * `sixb.env.ts` names, as a server reads them. Never `prod`: a branch runs code nobody reviewed.
 * Null when the project has no source, or the deployment gave no credential to read it with.
 */
export function branchDevEnv(
  projectRoot: string,
  tokenFile: string | undefined = process.env[BRANCH_DEV_ENV_TOKEN_FILE_ENV]
): () => Promise<Readonly<Record<string, string>> | null> {
  return async () => {
    const config = await loadEnvConfig(projectRoot)
    const source = config?.source
    if (!source) return null

    const needsToken = source.serverNeedsToken !== false
    if (needsToken && !tokenFile) return null

    const token = needsToken && tokenFile ? await readToken(tokenFile) : undefined
    return source.read("dev", { server: true, ...(token === undefined ? {} : { token }) })
  }
}

async function readToken(path: string): Promise<string> {
  const token = (
    await readFile(path, "utf8").catch(() => {
      throw new SixbCliError(`[SixbEnv] Could not read the branches' dev token file ${path}.`)
    })
  ).trim()
  if (!token) throw new SixbCliError(`[SixbEnv] The branches' dev token file ${path} is empty.`)
  return token
}
