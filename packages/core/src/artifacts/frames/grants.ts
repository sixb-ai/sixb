import { createHash, randomBytes } from "node:crypto"
import type { ArtifactStorage, ArtifactVersionRecord } from "../../storage/artifacts/types"

/** Path prefix of the route that serves a version's files to its frame. */
export const ARTIFACT_FRAME_ROUTE_PREFIX = "/api/artifact-frames/"

/** A frame link lasts an hour; the app asks for a new one before it runs out. */
const FRAME_LIFETIME_MS = 60 * 60 * 1000
/** 32 random bytes in base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface ArtifactFrame {
  /** The frame's base, ending in `/`: the version's files are served under it by their paths. */
  readonly path: string
  readonly expiresAt: Date
}

/**
 * Issues a link that serves one version's files to a sandboxed frame. The token in the link is
 * the credential: only its hash is stored. Whoever asks must already have been allowed to read
 * the version.
 */
export async function createArtifactFrame(input: {
  readonly projectId: string
  readonly storage: ArtifactStorage
  readonly artifactId: string
  readonly version: number
  readonly now?: Date
}): Promise<ArtifactFrame> {
  const createdAt = input.now ?? new Date()
  const expiresAt = new Date(createdAt.getTime() + FRAME_LIFETIME_MS)
  const token = randomBytes(32).toString("base64url")
  await input.storage.createFrameGrant({
    projectId: input.projectId,
    tokenHash: hashToken(token),
    artifactId: input.artifactId,
    version: input.version,
    createdAt,
    expiresAt,
  })
  return { path: `${ARTIFACT_FRAME_ROUTE_PREFIX}${token}/`, expiresAt }
}

/** The version a frame link serves, or `null` once it is unknown, expired, or its version gone. */
export async function resolveArtifactFrame(input: {
  readonly projectId: string
  readonly storage: ArtifactStorage
  readonly token: string
  readonly now?: Date
}): Promise<ArtifactVersionRecord | null> {
  if (!TOKEN_PATTERN.test(input.token)) return null
  const grant = await input.storage.findFrameGrant({
    projectId: input.projectId,
    tokenHash: hashToken(input.token),
  })
  if (!grant || grant.expiresAt <= (input.now ?? new Date())) return null
  return input.storage.getVersion({
    projectId: input.projectId,
    artifactId: grant.artifactId,
    version: grant.version,
  })
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
