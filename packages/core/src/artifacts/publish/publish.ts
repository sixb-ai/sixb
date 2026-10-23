import type { Principal } from "../../auth"
import { ArtifactStorageError } from "../../storage/artifacts/errors"
import type {
  ArtifactFile,
  ArtifactOrigin,
  ArtifactRecord,
  ArtifactStorage,
  ArtifactVersionInput,
  ArtifactVersionRecord,
  PublishedArtifactVersion,
} from "../../storage/artifacts/types"
import { type ArtifactAccess, assertUpdatable } from "../access"
import { ArtifactRequestError } from "../errors"
import { createArtifactId } from "../ids"
import type { ArtifactKind } from "../kinds"
import { ARTIFACT_LIMITS } from "../limits"
import type { ArtifactOutline } from "../outline"
import type { CheckedArtifactQuery } from "../queries"
import { ARTIFACT_THEME_FILE, parseArtifactTheme } from "../theme"
import type { ArtifactWarning } from "../warnings"
import {
  type ArtifactBlobStorage,
  checkArtifactFiles,
  invalidArtifact,
  readArtifactText,
} from "./files"
import { type ArtifactQueryChecker, checkArtifactQueries } from "./queries"
import {
  brokenDependents,
  type FoundReference,
  ownArtifacts,
  resolveReferences,
} from "./references"
import { validateCanvas } from "./validate/canvas"
import { validateDocument } from "./validate/document"
import { validateFileArtifact } from "./validate/file"
import { validatePage } from "./validate/page"
import { validateSheet } from "./validate/sheet"
import { validateSlides } from "./validate/slides"

export interface PublishArtifactContext {
  readonly projectId: string
  readonly storage: ArtifactStorage
  readonly blobStorage: ArtifactBlobStorage
}

export interface PublishArtifactInput {
  /** Publishes the next version of this artifact; without it, a new artifact is created. */
  readonly artifactId?: string
  readonly kind: ArtifactKind
  readonly title: string
  readonly files: readonly ArtifactFile[]
  /** Publishes the version, and owns the artifact when this creates it unless `owner` says. */
  readonly author: Principal
  /** Owns the artifact when this creates it: a conversation's owner, for an Agent turn in it. */
  readonly owner?: Principal
  /**
   * Whether an address in the version may name this artifact: one the author can read. Defaults to
   * the author's own artifacts.
   */
  readonly readable?: (artifact: ArtifactRecord) => Promise<boolean>
  /**
   * Checks each of the version's queries as the author, so none reads what they cannot. Without
   * it, a version that holds a query is refused.
   */
  readonly checkQuery?: ArtifactQueryChecker
  readonly origin?: ArtifactOrigin
  /** The version this one was made from: publishing fails with `artifact_moved` past it. */
  readonly baseVersion?: number
}

/**
 * What the author may do with the artifact a version is published to, as the access rule's
 * `publishAccess` answers it from where the version is stored: a transaction's storage, for a
 * caller that stores in one. Storing refuses `none` with `not_shared` and `read` with `read_only`.
 */
export type PublishAccess = (artifact: ArtifactRecord) => Promise<ArtifactAccess>

export interface PublishedArtifact {
  readonly artifact: ArtifactRecord
  readonly version: ArtifactVersionRecord
  readonly warnings: readonly ArtifactWarning[]
}

const CREATE_ATTEMPTS = 3

/** A version checked against its kind and with its addresses resolved, ready to store. */
export interface PreparedArtifactVersion {
  readonly artifactId?: string
  readonly baseVersion?: number
  readonly kind: ArtifactKind
  /** Owns the artifact when this version creates it. */
  readonly owner: Principal
  readonly readable: (artifact: ArtifactRecord) => Promise<boolean>
  readonly version: ArtifactVersionInput
  /** What its kind's check found worth fixing in a version it accepts. */
  readonly warnings: readonly ArtifactWarning[]
}

/**
 * Validates a version against its kind and stores it. Who may publish is the caller's decision:
 * this checks only what the version holds.
 */
export async function publishArtifact(
  context: PublishArtifactContext,
  input: PublishArtifactInput,
  access: PublishAccess
): Promise<PublishedArtifact> {
  const prepared = await prepareArtifactVersion(context, input)
  const stored = await storeArtifactVersion(context, prepared, access)
  return { ...stored, warnings: await artifactVersionWarnings(context, prepared, stored) }
}

/**
 * Everything publishing checks before it stores: the title, the files, the theme, every query, run
 * once as the author, the kind's own format, and every address, resolved against what the author
 * can read. It reads the files back and parses them, so a caller that stores inside a
 * transaction prepares outside it.
 */
export async function prepareArtifactVersion(
  context: PublishArtifactContext,
  input: PublishArtifactInput
): Promise<PreparedArtifactVersion> {
  const title = checkTitle(input.title)
  await checkArtifactFiles(context.blobStorage, input.files)
  if (input.kind !== "file") await checkTheme(context.blobStorage, input.files)

  // The queries first: a live sheet's columns are checked against what its query returns.
  const queries = await checkArtifactQueries(
    context.blobStorage,
    input.kind,
    input.files,
    input.checkQuery
  )
  const validated = await validateKind(context.blobStorage, input.kind, input.files, queries)

  const readable = input.readable ?? ownArtifacts(input.author)
  const references = await resolveReferences(
    referenceContext(context, { readable, artifactId: input.artifactId }),
    validated.references ?? []
  )

  return {
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
    kind: input.kind,
    owner: input.owner ?? input.author,
    readable,
    warnings: validated.warnings ?? [],
    version: {
      title,
      entry: validated.entry,
      files: input.files.map(({ path, file }) => ({ path, file: { ...file } })),
      outline: validated.outline,
      references,
      author: input.author,
      ...(input.origin ? { origin: input.origin } : {}),
      createdAt: new Date(),
    },
  }
}

/**
 * Stores a prepared version: the next one of its artifact, or the first of a new one. The next
 * version is refused unless `access` says its author may update the artifact: a caller that stores
 * inside a transaction answers it from there, so the check and the write see the same artifact.
 */
export async function storeArtifactVersion(
  context: PublishArtifactContext,
  prepared: PreparedArtifactVersion,
  access: PublishAccess
): Promise<PublishedArtifactVersion> {
  const { artifactId } = prepared
  if (!artifactId) {
    return createArtifact(context, prepared.kind, prepared.owner, prepared.version)
  }

  const artifact = await context.storage.get({ projectId: context.projectId, id: artifactId })
  if (!artifact) throw notFound(artifactId)
  assertUpdatable(artifactId, await access(artifact))

  return publishVersion(context, artifactId, prepared)
}

/**
 * What is worth fixing in a stored version: what its kind's check found, then what it breaks in
 * other artifacts that show it. A first version breaks nothing: no other artifact could name it
 * yet. The version is stored by now, so a failed check only loses those warnings.
 */
export async function artifactVersionWarnings(
  context: PublishArtifactContext,
  prepared: PreparedArtifactVersion,
  stored: PublishedArtifactVersion
): Promise<readonly ArtifactWarning[]> {
  if (!prepared.artifactId) return prepared.warnings
  try {
    return [
      ...prepared.warnings,
      ...(await brokenDependents(
        referenceContext(context, prepared),
        stored.artifact,
        stored.version
      )),
    ]
  } catch (error) {
    console.warn(
      `[Sixb] Could not check which artifacts version ${stored.version.version} of '${stored.artifact.id}' breaks:`,
      error
    )
    return prepared.warnings
  }
}

function referenceContext(
  context: PublishArtifactContext,
  input: {
    readonly readable: (artifact: ArtifactRecord) => Promise<boolean>
    readonly artifactId?: string
  }
) {
  return {
    projectId: context.projectId,
    storage: context.storage,
    readable: input.readable,
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
  }
}

async function validateKind(
  blobStorage: ArtifactBlobStorage,
  kind: ArtifactKind,
  files: readonly ArtifactFile[],
  queries: ReadonlyMap<string, CheckedArtifactQuery>
): Promise<{
  readonly entry: string
  readonly outline: ArtifactOutline
  readonly references?: readonly FoundReference[]
  readonly warnings?: readonly ArtifactWarning[]
}> {
  switch (kind) {
    case "document":
      return validateDocument(blobStorage, files)
    case "file":
      return validateFileArtifact(files)
    case "sheet":
      return validateSheet(blobStorage, files, queries)
    case "slides":
      return validateSlides(blobStorage, files)
    case "page":
      return validatePage(blobStorage, files)
    case "canvas":
      return validateCanvas(blobStorage, files)
    default:
      // A caller past the API's schema, such as a script on the SDK, can name any kind.
      throw invalidArtifact(`'${kind satisfies never}' is not a kind of artifact.`)
  }
}

async function checkTheme(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<void> {
  const themeFile = files.find((file) => file.path === ARTIFACT_THEME_FILE)
  if (!themeFile) return
  const parsed = parseArtifactTheme(
    await readArtifactText(blobStorage, themeFile, ARTIFACT_LIMITS.maxThemeBytes)
  )
  if ("error" in parsed) throw invalidArtifact(parsed.error)
}

function checkTitle(value: string): string {
  const title = typeof value === "string" ? value.trim() : ""
  if (title.length === 0 || /[\u0000-\u001f\u007f]/.test(title)) {
    throw invalidArtifact("An artifact needs a title of plain text.")
  }
  if (title.length > ARTIFACT_LIMITS.maxTitleLength) {
    throw invalidArtifact(`A title may be at most ${ARTIFACT_LIMITS.maxTitleLength} characters.`)
  }
  return title
}

async function publishVersion(
  context: PublishArtifactContext,
  artifactId: string,
  prepared: PreparedArtifactVersion
): Promise<PublishedArtifactVersion> {
  try {
    return await context.storage.publish({
      projectId: context.projectId,
      artifactId,
      kind: prepared.kind,
      version: prepared.version,
      ...(prepared.baseVersion === undefined ? {} : { baseVersion: prepared.baseVersion }),
    })
  } catch (error) {
    if (error instanceof ArtifactStorageError && error.code === "artifact_not_found") {
      throw new ArtifactRequestError("artifact_not_found", error.message)
    }
    if (error instanceof ArtifactStorageError && error.code === "artifact_kind_mismatch") {
      throw new ArtifactRequestError("artifact_kind_mismatch", error.message)
    }
    if (error instanceof ArtifactStorageError && error.code === "artifact_moved") {
      throw new ArtifactRequestError("artifact_moved", error.message, error.latest)
    }
    throw error
  }
}

function notFound(artifactId: string): ArtifactRequestError {
  return new ArtifactRequestError(
    "artifact_not_found",
    `[Sixb] Artifact '${artifactId}' was not found.`
  )
}

async function createArtifact(
  context: PublishArtifactContext,
  kind: ArtifactKind,
  owner: Principal,
  version: ArtifactVersionInput
): Promise<PublishedArtifactVersion> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await context.storage.create({
        projectId: context.projectId,
        id: createArtifactId(),
        kind,
        owner,
        version,
      })
    } catch (error) {
      const collided = error instanceof ArtifactStorageError && error.code === "artifact_exists"
      if (!collided || attempt === CREATE_ATTEMPTS) throw error
    }
  }
}
