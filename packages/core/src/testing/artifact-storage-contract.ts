import { describe, expect, test } from "bun:test"
import type { Principal } from "../auth"
import type { FileRef } from "../blob-storage"
import {
  type ArtifactFrameGrantRecord,
  type ArtifactStorage,
  ArtifactStorageError,
  type ArtifactStorageErrorCode,
  type ArtifactVersionInput,
  type CreateArtifactInput,
} from "../storage/artifacts"
import type { Storage } from "../storage/types"

export interface ArtifactStorageContractStorage extends Pick<Storage, "transaction"> {
  readonly artifacts: ArtifactStorage
}

export interface ArtifactStorageContractSuiteOptions<
  TStorage extends ArtifactStorageContractStorage = ArtifactStorageContractStorage,
> {
  /** Returns a fresh, empty storage bundle for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const projectId = "artifact-contract"
const otherProjectId = "artifact-contract-other"
const owner: Principal = { type: "user", id: "usr_owner" }
const otherOwner: Principal = { type: "user", id: "usr_other" }
const agentRun = { threadId: "thr_1", runId: "run_1" }
const t0 = new Date("2026-10-17T10:00:00.000Z")
const minute = 60 * 1000

/** Provider-neutral persistence contract for artifacts and their versions. */
export function runArtifactStorageContractSuite<TStorage extends ArtifactStorageContractStorage>(
  label: string,
  options: ArtifactStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (
    run: (artifacts: ArtifactStorage, storage: TStorage) => Promise<void>
  ): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage.artifacts, storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe(label, () => {
    test("creates an artifact with its first version and reads both back", async () => {
      await withStorage(async (artifacts) => {
        const created = await artifacts.create(createInput())

        expect(created.artifact).toEqual({
          projectId,
          id: "art_report",
          kind: "document",
          title: "Q3 report",
          owner,
          latestVersion: 1,
          createdAt: t0,
          updatedAt: t0,
        })
        expect(created.version).toEqual({
          projectId,
          artifactId: "art_report",
          version: 1,
          ...versionInput(),
        })
        expect(await artifacts.get({ projectId, id: "art_report" })).toEqual(created.artifact)
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_report", version: 1 })
        ).toEqual(created.version)
      })
    })

    test("rejects a second artifact with the same id in the same project", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())

        await expectArtifactError(artifacts.create(createInput()), "artifact_exists")
        await artifacts.create(createInput({ projectId: otherProjectId }))
      })
    })

    test("numbers versions in order and makes the newest the latest", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        const second = await artifacts.publish(
          publishInput({ title: "Q3 report, revised", createdAt: at(1) })
        )
        const third = await artifacts.publish(publishInput({ createdAt: at(2) }))

        expect(second.version.version).toBe(2)
        expect(third.version.version).toBe(3)
        expect(third.artifact).toMatchObject({ latestVersion: 3, updatedAt: at(2), createdAt: t0 })
        expect(second.artifact.title).toBe("Q3 report, revised")
        expect((await artifacts.get({ projectId, id: "art_report" }))?.title).toBe("Q3 report")
      })
    })

    test("keeps the kind fixed and refuses versions for a missing artifact", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())

        await expectArtifactError(
          artifacts.publish({ ...publishInput(), kind: "slides" }),
          "artifact_kind_mismatch"
        )
        await expectArtifactError(
          artifacts.publish({ ...publishInput(), artifactId: "art_missing" }),
          "artifact_not_found"
        )
        await expectArtifactError(
          artifacts.publish({ ...publishInput(), projectId: otherProjectId }),
          "artifact_not_found"
        )
        expect((await artifacts.get({ projectId, id: "art_report" }))?.latestVersion).toBe(1)
      })
    })

    test("publishes from a base version, and refuses one the artifact has moved past", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        const edited = await artifacts.publish({
          ...publishInput({ author: otherOwner, origin: undefined, createdAt: at(1) }),
          baseVersion: 1,
        })
        expect(edited.version.version).toBe(2)

        // A second save from version 1 would replace version 2's changes unseen.
        const error = await artifacts
          .publish({ ...publishInput({ createdAt: at(2) }), baseVersion: 1 })
          .then(
            () => null,
            (caught: unknown) => caught
          )
        expect(error).toBeInstanceOf(ArtifactStorageError)
        expect(error).toMatchObject({
          code: "artifact_moved",
          latest: { version: 2, author: otherOwner },
        })
        expect((await artifacts.get({ projectId, id: "art_report" }))?.latestVersion).toBe(2)

        // Of two publishes racing from one base, one is stored and the other finds it moved.
        // Reproduce by checking the base outside the publish's transaction.
        const raced = await Promise.allSettled([
          artifacts.publish({ ...publishInput({ createdAt: at(3) }), baseVersion: 2 }),
          artifacts.publish({ ...publishInput({ createdAt: at(4) }), baseVersion: 2 }),
        ])
        expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        const refused = raced.find((result) => result.status === "rejected")
        expect(refused?.status === "rejected" && refused.reason).toMatchObject({
          code: "artifact_moved",
          latest: { version: 3 },
        })
        // Without a base, a publish is stored over whatever is latest.
        expect((await artifacts.publish(publishInput({ createdAt: at(5) }))).version.version).toBe(
          4
        )
      })
    })

    test("stores a version's files, outline, references, and origin exactly", async () => {
      await withStorage(async (artifacts) => {
        const version = versionInput({
          entry: "index.html",
          files: [
            { path: "index.html", file: fileRef("a", "text/html") },
            { path: "img/fleet one.jpg", file: fileRef("b", "image/jpeg") },
          ],
          outline: { kind: "slides", slides: [{ title: "Q3 review" }, {}] },
          references: [
            {
              address: "artifact:art_numbers#chart=revenue",
              as: "embed",
              at: "3",
              resolvedVersion: 2,
            },
            { address: "artifact:art_report#methodology", as: "link", at: "5", resolvedVersion: 1 },
          ],
          origin: undefined,
        })
        const created = await artifacts.create(createInput({ kind: "slides", version }))

        expect(created.version).not.toHaveProperty("origin")
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_report", version: 1 })
        ).toEqual({ projectId, artifactId: "art_report", version: 1, ...version })
      })
    })

    test("keeps a page, and lists it as its kind", async () => {
      await withStorage(async (artifacts) => {
        const version = versionInput({
          entry: "index.html",
          files: [{ path: "index.html", file: fileRef("a", "text/html") }],
          outline: { kind: "page", title: "Fleet planner" },
        })
        await artifacts.create(createInput({ id: "art_planner", kind: "page", version }))
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_planner", version: 1 })
        ).toMatchObject({ outline: { kind: "page", title: "Fleet planner" } })
        const pages = await artifacts.list({ projectId, kind: "page", limit: 10 })
        expect(pages.artifacts.map((artifact) => artifact.id)).toEqual(["art_planner"])
      })
    })

    test("lists the latest versions that refer to an artifact, at any version, file, or part", async () => {
      await withStorage(async (artifacts) => {
        const refer = (address: string) => ({
          address,
          as: "embed" as const,
          at: "",
          resolvedVersion: 1,
        })
        const create = (id: string, addresses: string[], project = projectId) =>
          artifacts.create(
            createInput({
              projectId: project,
              id,
              version: versionInput({ references: addresses.map(refer) }),
            })
          )
        await create("art_numbers", [])
        await create("art_whole", ["artifact:art_numbers"])
        await create("art_pinned", ["artifact:art_numbers@1/figures/a.svg"])
        await create("art_chart", ["artifact:art_numbers#chart=revenue"])
        // A longer id that starts with the same letters is another artifact.
        await create("art_longer", ["artifact:art_numbersx#chart=revenue"])
        await create("art_elsewhere", ["artifact:art_numbers"], otherProjectId)
        // Only the latest version counts: this one dropped its reference.
        await create("art_dropped", ["artifact:art_numbers#Summary"])
        await artifacts.publish(publishInput({ createdAt: at(1) }, "art_dropped"))

        const referencing = await artifacts.listReferencingVersions({
          projectId,
          artifactId: "art_numbers",
        })
        // In artifact id order, whatever order they were published in. To see this fail, drop the
        // sort in `InMemoryArtifactStorage.listReferencingVersions`.
        expect(referencing.map((version) => version.artifactId)).toEqual([
          "art_chart",
          "art_pinned",
          "art_whole",
        ])
        expect(
          referencing.find((version) => version.artifactId === "art_chart")?.references
        ).toEqual([refer("artifact:art_numbers#chart=revenue")])
      })
    })

    test("stores frame grants by token hash, expires them in batches, and drops them with the artifact", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        const grant = (seed: string, expiresInMinutes: number) =>
          frameGrant(seed, { expiresAt: at(expiresInMinutes) })
        await artifacts.createFrameGrant(grant("a", 60))
        await artifacts.createFrameGrant(grant("b", 5))
        await artifacts.createFrameGrant(grant("c", 10))

        expect(await artifacts.findFrameGrant({ projectId, tokenHash: "a".repeat(64) })).toEqual(
          grant("a", 60)
        )
        expect(
          await artifacts.findFrameGrant({ projectId: otherProjectId, tokenHash: "a".repeat(64) })
        ).toBeNull()
        await expectArtifactError(
          artifacts.createFrameGrant({ ...grant("d", 60), artifactId: "art_missing" }),
          "artifact_not_found"
        )

        // Expired before minute 30: b and c, one at a time.
        const expiredBefore = at(30)
        expect(
          await artifacts.deleteExpiredFrameGrants({ projectId, expiredBefore, limit: 1 })
        ).toBe(1)
        expect(
          await artifacts.deleteExpiredFrameGrants({ projectId, expiredBefore, limit: 10 })
        ).toBe(1)
        expect(await artifacts.findFrameGrant({ projectId, tokenHash: "b".repeat(64) })).toBeNull()
        expect(
          await artifacts.findFrameGrant({ projectId, tokenHash: "a".repeat(64) })
        ).not.toBeNull()

        await artifacts.delete({ projectId, id: "art_report" })
        expect(await artifacts.findFrameGrant({ projectId, tokenHash: "a".repeat(64) })).toBeNull()
      })
    })

    test("lists the latest of each artifact, most recently updated first", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput({ id: "art_a" }))
        await artifacts.create(
          createInput({ id: "art_b", version: versionInput({ createdAt: at(1) }) })
        )
        await artifacts.create(
          createInput({ id: "art_c", version: versionInput({ createdAt: at(2) }) })
        )
        await artifacts.publish(publishInput({ createdAt: at(3) }, "art_a"))

        const all = await artifacts.list({ projectId })
        expect(all.artifacts.map((artifact) => artifact.id)).toEqual(["art_a", "art_c", "art_b"])
        expect(all).toMatchObject({ total: 3, hasMore: false })

        const page = await artifacts.list({ projectId, limit: 2, offset: 1 })
        expect(page.artifacts.map((artifact) => artifact.id)).toEqual(["art_c", "art_b"])
        expect(page).toMatchObject({ total: 3, hasMore: false })
        expect((await artifacts.list({ projectId, limit: 1 })).hasMore).toBe(true)
      })
    })

    test("lists one kind, counting only that kind", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput({ id: "art_doc" }))
        await artifacts.create(createInput({ id: "art_deck_a", kind: "slides" }))
        await artifacts.create(
          createInput({
            id: "art_deck_b",
            kind: "slides",
            version: versionInput({ createdAt: at(1) }),
          })
        )
        const decks = await artifacts.list({ projectId, kind: "slides", limit: 1 })
        expect(decks.artifacts.map((artifact) => artifact.id)).toEqual(["art_deck_b"])
        expect(decks).toMatchObject({ total: 2, hasMore: true })
        expect((await artifacts.list({ projectId, kind: "sheet" })).total).toBe(0)
      })
    })

    test("lists by owner, by the thread a version came from, and only within the project", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput({ id: "art_mine" }))
        await artifacts.create(
          createInput({
            id: "art_theirs",
            owner: otherOwner,
            version: versionInput({
              author: otherOwner,
              origin: { threadId: "thr_2", runId: "run_2" },
            }),
          })
        )
        await artifacts.create(
          createInput({ id: "art_api", version: versionInput({ origin: undefined }) })
        )
        await artifacts.publish(
          publishInput(
            { origin: { threadId: "thr_3", runId: "run_3" }, createdAt: at(1) },
            "art_api"
          )
        )
        await artifacts.create(createInput({ projectId: otherProjectId, id: "art_elsewhere" }))

        const ids = async (input: Parameters<ArtifactStorage["list"]>[0]) =>
          (await artifacts.list(input)).artifacts.map((artifact) => artifact.id).sort()

        expect(await ids({ projectId, owner })).toEqual(["art_api", "art_mine"])
        expect(await ids({ projectId, owner: otherOwner })).toEqual(["art_theirs"])
        expect(await ids({ projectId, originThreadId: "thr_1" })).toEqual(["art_mine"])
        expect(await ids({ projectId, originThreadId: "thr_3" })).toEqual(["art_api"])
        expect(await ids({ projectId, owner, originThreadId: "thr_2" })).toEqual([])
        expect(await ids({ projectId: otherProjectId })).toEqual(["art_elsewhere"])
      })
    })

    test("lists versions newest first, a page at a time", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        await artifacts.publish(publishInput({ createdAt: at(1) }))
        await artifacts.publish(publishInput({ createdAt: at(2) }))

        const all = await artifacts.listVersions({ projectId, artifactId: "art_report" })
        expect(all.versions.map((version) => version.version)).toEqual([3, 2, 1])
        expect(all).toMatchObject({ total: 3, hasMore: false })

        const page = await artifacts.listVersions({
          projectId,
          artifactId: "art_report",
          limit: 1,
          offset: 1,
        })
        expect(page.versions.map((version) => version.version)).toEqual([2])
        expect(page).toMatchObject({ total: 3, hasMore: true })
        expect(await artifacts.listVersions({ projectId, artifactId: "art_missing" })).toEqual({
          versions: [],
          hasMore: false,
          total: 0,
        })
      })
    })

    test("deletes an artifact with every version", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        await artifacts.publish(publishInput({ createdAt: at(1) }))

        expect(await artifacts.delete({ projectId: otherProjectId, id: "art_report" })).toBe(false)
        expect(await artifacts.delete({ projectId, id: "art_report" })).toBe(true)
        expect(await artifacts.get({ projectId, id: "art_report" })).toBeNull()
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_report", version: 1 })
        ).toBeNull()
        expect(await artifacts.delete({ projectId, id: "art_report" })).toBe(false)

        // The id is free again, and numbering starts over for the new artifact.
        expect((await artifacts.create(createInput())).version.version).toBe(1)
      })
    })

    test("deletes a run's versions, repoints latest, and never reuses a number", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(
          createInput({ version: versionInput({ origin: { threadId: "thr_1", runId: "run_0" } }) })
        )
        await artifacts.publish(
          publishInput({
            title: "Kept",
            createdAt: at(1),
            origin: { threadId: "thr_1", runId: "run_0" },
          })
        )
        await artifacts.publish(publishInput({ title: "Retried", createdAt: at(2) }))
        await artifacts.create(
          createInput({ id: "art_new_in_run", version: versionInput({ createdAt: at(2) }) })
        )
        await artifacts.create(
          createInput({
            id: "art_other_run",
            version: versionInput({ origin: { threadId: "thr_1", runId: "run_9" } }),
          })
        )
        await artifacts.createFrameGrant(frameGrant("a"))
        await artifacts.createFrameGrant(frameGrant("b", { artifactId: "art_new_in_run" }))

        expect(
          await artifacts.deleteVersionsByOrigin({ projectId: otherProjectId, runId: "run_1" })
        ).toBe(0)
        expect(await artifacts.deleteVersionsByOrigin({ projectId, runId: "run_1" })).toBe(2)

        expect(await artifacts.get({ projectId, id: "art_report" })).toMatchObject({
          title: "Kept",
          latestVersion: 2,
          updatedAt: at(1),
        })
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_report", version: 3 })
        ).toBeNull()
        expect(await artifacts.get({ projectId, id: "art_new_in_run" })).toBeNull()
        expect(await artifacts.get({ projectId, id: "art_other_run" })).not.toBeNull()
        // A deleted artifact's frame grants go with it; a kept one's stay. To see this fail, delete
        // the artifact from the map alone in `InMemoryArtifactStorage.deleteVersionsByOrigin`.
        expect(await artifacts.findFrameGrant({ projectId, tokenHash: "b".repeat(64) })).toBeNull()
        expect(
          await artifacts.findFrameGrant({ projectId, tokenHash: "a".repeat(64) })
        ).not.toBeNull()

        // Version 3 belonged to the retried run; the next one is 4, so an address pinned to @3
        // can never land on different content.
        expect((await artifacts.publish(publishInput({ createdAt: at(3) }))).version.version).toBe(
          4
        )
      })
    })

    test("rolls back with its containing storage transaction", async () => {
      await withStorage(async (artifacts, storage) => {
        await artifacts.create(createInput())
        const rollback = new Error("rollback artifact publish")

        await expect(
          storage.transaction(async (tx) => {
            if (!tx.artifacts) throw new Error("Expected artifact storage in the transaction.")
            await tx.artifacts.publish(publishInput({ createdAt: at(1) }))
            await tx.artifacts.create(createInput({ id: "art_rolled_back" }))
            await tx.artifacts.createFrameGrant(frameGrant("a"))
            expect((await tx.artifacts.get({ projectId, id: "art_report" }))?.latestVersion).toBe(2)
            throw rollback
          })
        ).rejects.toBe(rollback)

        expect((await artifacts.get({ projectId, id: "art_report" }))?.latestVersion).toBe(1)
        expect(await artifacts.get({ projectId, id: "art_rolled_back" })).toBeNull()
        // To see this fail, leave frame grants out of `InMemoryArtifactStorage.restore`.
        expect(await artifacts.findFrameGrant({ projectId, tokenHash: "a".repeat(64) })).toBeNull()
        expect((await artifacts.publish(publishInput({ createdAt: at(2) }))).version.version).toBe(
          2
        )
      })
    })
  })
}

async function expectArtifactError(
  promise: Promise<unknown>,
  code: ArtifactStorageErrorCode
): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ArtifactStorageError)
  expect((error as ArtifactStorageError).code).toBe(code)
}

function createInput(overrides: Partial<CreateArtifactInput> = {}): CreateArtifactInput {
  return {
    projectId,
    id: "art_report",
    kind: "document",
    owner,
    version: versionInput(),
    ...overrides,
  }
}

function publishInput(overrides: Partial<ArtifactVersionInput> = {}, artifactId = "art_report") {
  return {
    projectId,
    artifactId,
    kind: "document" as const,
    version: versionInput({ origin: agentRun, ...overrides }),
  }
}

function versionInput(overrides: Partial<ArtifactVersionInput> = {}): ArtifactVersionInput {
  const input: ArtifactVersionInput = {
    title: "Q3 report",
    entry: "document.md",
    files: [{ path: "document.md", file: fileRef("d", "text/markdown") }],
    outline: { kind: "document", headings: [{ depth: 2, text: "Revenue", slug: "revenue" }] },
    references: [],
    author: owner,
    origin: agentRun,
    createdAt: t0,
    ...overrides,
  }
  if (input.origin) return input
  const { origin: _origin, ...withoutOrigin } = input
  return withoutOrigin
}

function frameGrant(
  seed: string,
  overrides: Partial<ArtifactFrameGrantRecord> = {}
): ArtifactFrameGrantRecord {
  return {
    projectId,
    tokenHash: seed.repeat(64).slice(0, 64),
    artifactId: "art_report",
    version: 1,
    targets: [
      { address: "artifact:art_other/figures/revenue.svg", artifactId: "art_other", version: 3 },
    ],
    createdAt: t0,
    expiresAt: at(60),
    ...overrides,
  }
}

function fileRef(seed: string, mediaType: string): FileRef {
  const hex = seed.repeat(64).slice(0, 64)
  return {
    blobId: `blob_${hex}`,
    digest: `sha256:${hex}`,
    sizeBytes: 42,
    fileName: `${seed}.bin`,
    mediaType,
  }
}

function at(minutes: number): Date {
  return new Date(t0.getTime() + minutes * minute)
}
