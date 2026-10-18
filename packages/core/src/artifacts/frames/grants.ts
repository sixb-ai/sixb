import { createHash, randomBytes } from "node:crypto"
import type {
  ArtifactFrameTarget,
  ArtifactStorage,
  ArtifactVersionRecord,
} from "../../storage/artifacts/types"
import { parseArtifactAddress } from "../address"
import { ArtifactRequestError } from "../errors"

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

type ReadArtifactVersion = (
  artifactId: string,
  version: number | "latest"
) => Promise<ArtifactVersionRecord | null>

/**
 * Issues a link that serves a deck's version to a sandboxed frame, with the files it embeds from
 * other artifacts that `read` finds. The token in the link is the credential: only its hash is
 * stored. Whoever asks must already have been allowed to read the version, and `read` reads as
 * them. Only a deck opens in a frame, since the frame serves its entry as a page.
 */
export async function createArtifactFrame(input: {
  readonly projectId: string
  readonly storage: ArtifactStorage
  readonly version: ArtifactVersionRecord
  readonly read?: ReadArtifactVersion
  readonly now?: Date
}): Promise<ArtifactFrame> {
  const { version } = input
  if (version.outline.kind !== "slides") {
    throw new ArtifactRequestError(
      "artifact_kind_mismatch",
      `[Sixb] Only a deck opens in a frame; '${version.artifactId}' is a ${version.outline.kind}. Read its files instead.`
    )
  }
  const createdAt = input.now ?? new Date()
  const expiresAt = new Date(createdAt.getTime() + FRAME_LIFETIME_MS)
  const token = randomBytes(32).toString("base64url")
  await input.storage.createFrameGrant({
    projectId: input.projectId,
    tokenHash: hashToken(token),
    artifactId: version.artifactId,
    version: version.version,
    targets: input.read ? await frameTargets(version, input.read) : [],
    createdAt,
    expiresAt,
  })
  return { path: `${ARTIFACT_FRAME_ROUTE_PREFIX}${token}/`, expiresAt }
}

/**
 * The files from other artifacts a version's frame may show its reader: each file it embeds
 * (`<img src="artifact:…/figure.svg">`) that `read`, as the reader, finds, at the version the
 * address pins or the latest. A chart, range, or section is drawn by the app over the frame, under
 * the reader's own session, and needs nothing here.
 */
async function frameTargets(
  version: ArtifactVersionRecord,
  read: ReadArtifactVersion
): Promise<ArtifactFrameTarget[]> {
  const targets: ArtifactFrameTarget[] = []
  for (const reference of version.references) {
    if (
      reference.as !== "embed" ||
      targets.some((target) => target.address === reference.address)
    ) {
      continue
    }
    const address = parseArtifactAddress(reference.address)
    if (!address?.path) continue
    const target = await read(address.artifactId, address.version ?? "latest").catch(() => null)
    if (!target?.files.some((file) => file.path === address.path)) continue
    targets.push({
      address: reference.address,
      artifactId: target.artifactId,
      version: target.version,
    })
  }
  return targets
}

/**
 * What a frame link serves: its deck's version, and what it may show from other artifacts; `null`
 * once the link is unknown, expired, or its version gone, and for a version that is not a deck.
 */
export async function resolveArtifactFrame(input: {
  readonly projectId: string
  readonly storage: ArtifactStorage
  readonly token: string
  readonly now?: Date
}): Promise<{
  readonly version: ArtifactVersionRecord
  readonly targets: readonly ArtifactFrameTarget[]
} | null> {
  if (!TOKEN_PATTERN.test(input.token)) return null
  const grant = await input.storage.findFrameGrant({
    projectId: input.projectId,
    tokenHash: hashToken(input.token),
  })
  if (!grant || grant.expiresAt <= (input.now ?? new Date())) return null
  const version = await input.storage.getVersion({
    projectId: input.projectId,
    artifactId: grant.artifactId,
    version: grant.version,
  })
  return version?.outline.kind === "slides" ? { version, targets: grant.targets } : null
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
