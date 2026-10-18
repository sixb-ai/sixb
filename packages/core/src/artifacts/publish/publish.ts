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
import { ArtifactRequestError } from "../errors"
import { createArtifactId } from "../ids"
import type { ArtifactKind } from "../kinds"
import { ARTIFACT_LIMITS } from "../limits"
import type { ArtifactOutline } from "../outline"
import { ARTIFACT_THEME_FILE, parseArtifactTheme } from "../theme"
import type { ArtifactWarning } from "../warnings"
import {
  type ArtifactBlobStorage,
  checkArtifactFiles,
  invalidArtifact,
  readArtifactText,
} from "./files"
import { brokenDependents, type FoundReference, resolveReferences } from "./references"
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
  /** Publishes the version, and owns the artifact when this creates it. */
  readonly author: Principal
  readonly origin?: ArtifactOrigin
}

export interface PublishedArtifact {
  readonly artifact: ArtifactRecord
  readonly version: ArtifactVersionRecord
  readonly warnings: readonly ArtifactWarning[]
}

const CREATE_ATTEMPTS = 3

/** A version checked against its kind and with its addresses resolved, ready to store. */
export interface PreparedArtifactVersion {
  readonly artifactId?: string
  readonly kind: ArtifactKind
  readonly author: Principal
  readonly version: ArtifactVersionInput
}

/**
 * Validates a version against its kind and stores it. Who may publish is the caller's decision:
 * this checks only what the version holds.
 */
export async function publishArtifact(
  context: PublishArtifactContext,
  input: PublishArtifactInput
): Promise<PublishedArtifact> {
  const prepared = await prepareArtifactVersion(context, input)
  const stored = await storeArtifactVersion(context, prepared)
  return { ...stored, warnings: await artifactVersionWarnings(context, prepared, stored) }
}

/**
 * Everything publishing checks before it stores: the title, the files, the theme, the kind's own
 * format, and every address, resolved against what the author can read. It reads the files back
 * and parses them, so a caller that stores inside a transaction prepares outside it.
 */
export async function prepareArtifactVersion(
  context: PublishArtifactContext,
  input: PublishArtifactInput
): Promise<PreparedArtifactVersion> {
  const title = checkTitle(input.title)
  await checkArtifactFiles(context.blobStorage, input.files)
  if (input.kind !== "file") await checkTheme(context.blobStorage, input.files)
  const validated = await validateKind(context.blobStorage, input.kind, input.files)
  const references = await resolveReferences(
    referenceContext(context, input),
    validated.references ?? []
  )
  return {
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    kind: input.kind,
    author: input.author,
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

/** Stores a prepared version: the next one of its artifact, or the first of a new one. */
export async function storeArtifactVersion(
  context: PublishArtifactContext,
  prepared: PreparedArtifactVersion
): Promise<PublishedArtifactVersion> {
  return prepared.artifactId
    ? publishVersion(context, prepared.artifactId, prepared.kind, prepared.version)
    : createArtifact(context, prepared.kind, prepared.author, prepared.version)
}

/**
 * What a stored version breaks in other artifacts that show it. A first version breaks nothing:
 * no other artifact could name it yet. The version is stored by now, so a failed check only loses
 * the warnings.
 */
export async function artifactVersionWarnings(
  context: PublishArtifactContext,
  prepared: PreparedArtifactVersion,
  stored: PublishedArtifactVersion
): Promise<readonly ArtifactWarning[]> {
  if (!prepared.artifactId) return []
  try {
    return await brokenDependents(
      referenceContext(context, prepared),
      stored.artifact,
      stored.version
    )
  } catch (error) {
    console.warn(
      `[Sixb] Could not check which artifacts version ${stored.version.version} of '${stored.artifact.id}' breaks:`,
      error
    )
    return []
  }
}

function referenceContext(
  context: PublishArtifactContext,
  input: { readonly author: Principal; readonly artifactId?: string }
) {
  return {
    projectId: context.projectId,
    storage: context.storage,
    author: input.author,
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
  }
}

async function validateKind(
  blobStorage: ArtifactBlobStorage,
  kind: ArtifactKind,
  files: readonly ArtifactFile[]
): Promise<{
  readonly entry: string
  readonly outline: ArtifactOutline
  readonly references?: readonly FoundReference[]
}> {
  switch (kind) {
    case "document":
      return validateDocument(blobStorage, files)
    case "file":
      return validateFileArtifact(files)
    case "sheet":
      return validateSheet(blobStorage, files)
    case "slides":
      return validateSlides(blobStorage, files)
    case "page":
      return validatePage(blobStorage, files)
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
  kind: ArtifactKind,
  version: ArtifactVersionInput
): Promise<PublishedArtifactVersion> {
  try {
    return await context.storage.publish({
      projectId: context.projectId,
      artifactId,
      kind,
      version,
    })
  } catch (error) {
    if (error instanceof ArtifactStorageError && error.code === "artifact_not_found") {
      throw new ArtifactRequestError("artifact_not_found", error.message)
    }
    if (error instanceof ArtifactStorageError && error.code === "artifact_kind_mismatch") {
      throw new ArtifactRequestError("artifact_kind_mismatch", error.message)
    }
    throw error
  }
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
