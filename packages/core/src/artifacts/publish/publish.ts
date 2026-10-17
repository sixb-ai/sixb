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

/**
 * Validates a version against its kind and stores it. Who may publish is the caller's decision:
 * this checks only what the version holds.
 */
export async function publishArtifact(
  context: PublishArtifactContext,
  input: PublishArtifactInput
): Promise<PublishedArtifact> {
  const title = checkTitle(input.title)
  await checkArtifactFiles(context.blobStorage, input.files)
  if (input.kind !== "file") await checkTheme(context.blobStorage, input.files)
  const validated = await validateKind(context.blobStorage, input.kind, input.files)
  const { entry, outline } = validated
  const referenceContext = {
    projectId: context.projectId,
    storage: context.storage,
    author: input.author,
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
  }
  const references = await resolveReferences(referenceContext, validated.references ?? [])

  const version: ArtifactVersionInput = {
    title,
    entry,
    files: input.files.map(({ path, file }) => ({ path, file: { ...file } })),
    outline,
    references,
    author: input.author,
    ...(input.origin ? { origin: input.origin } : {}),
    createdAt: new Date(),
  }
  const stored = input.artifactId
    ? await publishVersion(context, input.artifactId, input.kind, version)
    : await createArtifact(context, input.kind, input.author, version)
  // A first version breaks nothing: no other artifact could name it yet. The version is stored by
  // now, and for the Agent inside its run's transaction, so a failed check only loses warnings.
  let warnings: readonly ArtifactWarning[] = []
  if (input.artifactId) {
    try {
      warnings = await brokenDependents(referenceContext, stored.artifact, stored.version)
    } catch (error) {
      console.warn(
        `[Sixb] Could not check which artifacts version ${stored.version.version} of '${stored.artifact.id}' breaks:`,
        error
      )
    }
  }
  return { ...stored, warnings }
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
      throw invalidArtifact(`Publishing a ${kind} is not supported yet.`)
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
