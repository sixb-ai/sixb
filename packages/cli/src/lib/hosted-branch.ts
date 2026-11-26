import {
  BRANCH_KEY_ENV,
  BRANCH_PORT_ENV,
  BRANCH_PRODUCTION_ORIGIN_ENV,
  BRANCH_PUBLIC_ORIGIN_ENV,
} from "@sixb/core/internal/branches"

/** A hosted branch's runtime: its front on its port, its API on the next, its app after. */
export interface HostedBranchRuntime {
  readonly branch: string
  readonly key: string
  readonly ports: { readonly front: number; readonly api: number; readonly app: number }
  /** Where the front is reached from outside the sandbox. */
  readonly publicOrigin: string
  /** Production's app, when the deployment says where: the banner's Refresh opens it. */
  readonly productionOrigin: string | null
}

/**
 * The branch this `sixb dev` runs as next to production, when production started it: its key is
 * then in the environment, beside the branch mode's variables. Null for a laptop's `sixb dev`.
 */
export function hostedBranchRuntime(): HostedBranchRuntime | null {
  const branch = process.env.SIXB_BRANCH
  const key = process.env[BRANCH_KEY_ENV]
  if (key === undefined) return null

  if (!branch) {
    throw new Error(
      `[SixbDev] ${BRANCH_KEY_ENV} is set without SIXB_BRANCH: only production starts a hosted branch's runtime.`
    )
  }
  if (key.length < 32) {
    throw new Error(
      `[SixbDev] ${BRANCH_KEY_ENV} must be at least 32 characters: production sends it with every request.`
    )
  }

  const front = Number(process.env[BRANCH_PORT_ENV])
  if (!Number.isInteger(front) || front < 1 || front > 65_533) {
    throw new Error(
      `[SixbDev] ${BRANCH_PORT_ENV} must be the port production reaches the branch on.`
    )
  }

  return {
    branch,
    key,
    ports: { front, api: front + 1, app: front + 2 },
    publicOrigin: process.env[BRANCH_PUBLIC_ORIGIN_ENV] || `http://127.0.0.1:${front}`,
    productionOrigin: process.env[BRANCH_PRODUCTION_ORIGIN_ENV] || null,
  }
}
