import { describe, expect, test } from "bun:test"
import { ARTIFACT_RESTORE_POINTS, ARTIFACT_STATE_LIMITS } from "../artifacts/limits"
import type { Principal } from "../auth"
import type { FileRef } from "../blob-storage"
import {
  type ArtifactFrameGrantRecord,
  type ArtifactStorage,
  ArtifactStorageError,
  type ArtifactStorageErrorCode,
  type ArtifactVersionInput,
  type CreateArtifactInput,
  type PublishArtifactVersionInput,
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
    test("creates an artifact with its first version, open, and reads both back", async () => {
      await withStorage(async (artifacts) => {
        const created = await artifacts.create(createInput())

        expect(created.artifact).toEqual({
          projectId,
          id: "art_report",
          kind: "document",
          title: "Q3 report",
          owner,
          latestVersion: 1,
          revision: 1,
          createdAt: t0,
          updatedAt: t0,
        })
        expect(created.version).toEqual({
          projectId,
          artifactId: "art_report",
          version: 1,
          revision: 1,
          ...versionInput(),
          createdAt: t0,
        })
        expect(created.version).not.toHaveProperty("frozenAt")
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

    // Regression proof: append a version on every write in a provider's `publish`; the second
    // write is then version 2.
    test("replaces the open version's content in place, one revision at a time", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        const second = await artifacts.publish(
          publishInput({ title: "Q3 report, revised", author: otherOwner, updatedAt: at(1) })
        )
        const third = await artifacts.publish(publishInput({ origin: undefined, updatedAt: at(2) }))

        expect(second.version).toMatchObject({
          version: 1,
          revision: 2,
          title: "Q3 report, revised",
          author: otherOwner,
          createdAt: t0,
          updatedAt: at(1),
        })
        expect(third.artifact).toMatchObject({
          latestVersion: 1,
          revision: 3,
          title: "Q3 report",
          createdAt: t0,
          updatedAt: at(2),
        })
        // The last write's author and origin are the version's: it had none.
        expect(third.version).toMatchObject({ version: 1, revision: 3, author: owner })
        expect(third.version).not.toHaveProperty("origin")
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_report", version: 1 })
        ).toEqual(third.version)
        expect((await artifacts.listVersions({ projectId, artifactId: "art_report" })).total).toBe(
          1
        )
      })
    })

    // Regression proof: write in place whatever the latest version is in a provider's `publish`;
    // the frozen version then changes.
    test("freezes the latest version, and the next write opens the next one", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        const frozen = await artifacts.freeze({
          projectId,
          artifactId: "art_report",
          baseRevision: 1,
          frozenAt: at(1),
          frozenBy: otherOwner,
        })
        expect(frozen.artifact).toMatchObject({ latestVersion: 1, revision: 2, updatedAt: at(1) })
        // Who froze it is kept beside who wrote it.
        expect(frozen.version).toMatchObject({
          version: 1,
          revision: 2,
          author: owner,
          frozenAt: at(1),
          frozenBy: otherOwner,
        })

        // A write made before the freeze is told who created the version since.
        // Reproduce by leaving `frozenBy` out of a provider's `assertBase`.
        const moved = await artifacts
          .publish({ ...publishInput({ updatedAt: at(2) }), baseRevision: 1 })
          .catch((error: unknown) => error)
        expect(moved).toMatchObject({
          code: "artifact_moved",
          latest: { version: 1, revision: 2, author: owner, frozenBy: otherOwner },
        })
        expect((moved as Error).message).toContain("which user 'usr_other' created")

        // Freezing a frozen version changes nothing, from any base.
        expect(
          await artifacts.freeze({
            projectId,
            artifactId: "art_report",
            baseRevision: 1,
            frozenAt: at(2),
            frozenBy: otherOwner,
          })
        ).toEqual(frozen)

        const opened = await artifacts.publish(publishInput({ title: "Draft", updatedAt: at(3) }))
        expect(opened.version).toMatchObject({
          version: 2,
          revision: 3,
          title: "Draft",
          createdAt: at(3),
          updatedAt: at(3),
        })
        expect(opened.version).not.toHaveProperty("frozenAt")
        expect(opened.version).not.toHaveProperty("frozenBy")
        expect(opened.artifact).toMatchObject({ latestVersion: 2, revision: 3, title: "Draft" })

        // The next write replaces version 2, and version 1 stays as it was frozen.
        const replaced = await artifacts.publish(publishInput({ title: "Final", updatedAt: at(4) }))
        expect(replaced.version).toMatchObject({ version: 2, revision: 4, title: "Final" })
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_report", version: 1 })
        ).toEqual(frozen.version)

        await expectArtifactError(
          artifacts.freeze({
            projectId,
            artifactId: "art_missing",
            frozenAt: at(5),
            frozenBy: otherOwner,
          }),
          "artifact_not_found"
        )
      })
    })

    test("keeps the kind fixed and refuses writes to a missing artifact", async () => {
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
        expect((await artifacts.get({ projectId, id: "art_report" }))?.revision).toBe(1)
      })
    })

    test("writes from a base revision, and refuses one the artifact has moved past", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        const edited = await artifacts.publish({
          ...publishInput({ author: otherOwner, origin: undefined, updatedAt: at(1) }),
          baseRevision: 1,
        })
        expect(edited.artifact.revision).toBe(2)

        // A second save from revision 1 would replace revision 2's changes unseen.
        const error = await artifacts
          .publish({ ...publishInput({ updatedAt: at(2) }), baseRevision: 1 })
          .then(
            () => null,
            (caught: unknown) => caught
          )
        expect(error).toBeInstanceOf(ArtifactStorageError)
        expect(error).toMatchObject({
          code: "artifact_moved",
          latest: { version: 1, revision: 2, author: otherOwner },
        })
        expect((await artifacts.get({ projectId, id: "art_report" }))?.revision).toBe(2)

        // A freeze moves it too: nobody freezes content they never saw.
        await expectArtifactError(
          artifacts.freeze({
            projectId,
            artifactId: "art_report",
            baseRevision: 1,
            frozenAt: at(2),
            frozenBy: otherOwner,
          }),
          "artifact_moved"
        )

        // Of two writes racing from one base, one is stored and the other finds it moved. This
        // fixes the outcome only: the in-memory and SQLite storages run each call whole under
        // their own lock, so the race cannot fail there. Postgres proves its row lock in
        // `storage/pg/tests/pg-artifact-storage.e2e.ts`.
        const raced = await Promise.allSettled([
          artifacts.publish({ ...publishInput({ updatedAt: at(3) }), baseRevision: 2 }),
          artifacts.publish({ ...publishInput({ updatedAt: at(4) }), baseRevision: 2 }),
        ])
        expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        const refused = raced.find((result) => result.status === "rejected")
        expect(refused?.status === "rejected" && refused.reason).toMatchObject({
          code: "artifact_moved",
          latest: { revision: 3 },
        })
        // Without a base, a write is stored over whatever is latest.
        expect(
          (await artifacts.publish(publishInput({ updatedAt: at(5) }))).artifact.revision
        ).toBe(4)
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
        ).toEqual({
          projectId,
          artifactId: "art_report",
          version: 1,
          revision: 1,
          ...version,
          createdAt: t0,
        })
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
        // Only the latest version counts: this one dropped its reference, frozen before.
        await create("art_dropped", ["artifact:art_numbers#Summary"])
        await artifacts.freeze({
          projectId,
          artifactId: "art_dropped",
          frozenAt: at(1),
          frozenBy: otherOwner,
        })
        await artifacts.publish(publishInput({ updatedAt: at(2) }, "art_dropped"))
        // And this one dropped it from its open version.
        await create("art_rewritten", ["artifact:art_numbers"])
        await artifacts.publish(publishInput({ updatedAt: at(2) }, "art_rewritten"))

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
          createInput({ id: "art_b", version: versionInput({ updatedAt: at(1) }) })
        )
        await artifacts.create(
          createInput({ id: "art_c", version: versionInput({ updatedAt: at(2) }) })
        )
        await artifacts.publish(publishInput({ updatedAt: at(3) }, "art_a"))
        // A freeze is a change too.
        await artifacts.freeze({
          projectId,
          artifactId: "art_b",
          frozenAt: at(4),
          frozenBy: otherOwner,
        })

        const all = await artifacts.list({ projectId })
        expect(all.artifacts.map((artifact) => artifact.id)).toEqual(["art_b", "art_a", "art_c"])
        expect(all).toMatchObject({ total: 3, hasMore: false })

        const page = await artifacts.list({ projectId, limit: 2, offset: 1 })
        expect(page.artifacts.map((artifact) => artifact.id)).toEqual(["art_a", "art_c"])
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
            version: versionInput({ updatedAt: at(1) }),
          })
        )
        const decks = await artifacts.list({ projectId, kind: "slides", limit: 1 })
        expect(decks.artifacts.map((artifact) => artifact.id)).toEqual(["art_deck_b"])
        expect(decks).toMatchObject({ total: 2, hasMore: true })
        expect((await artifacts.list({ projectId, kind: "sheet" })).total).toBe(0)
      })
    })

    test("lists by owner, by the thread it is shared in, and only within the project", async () => {
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
            { origin: { threadId: "thr_3", runId: "run_3" }, updatedAt: at(1) },
            "art_api"
          )
        )
        await artifacts.create(createInput({ projectId: otherProjectId, id: "art_elsewhere" }))

        const ids = async (input: Parameters<ArtifactStorage["list"]>[0]) =>
          (await artifacts.list(input)).artifacts.map((artifact) => artifact.id).sort()

        expect(await ids({ projectId, owner })).toEqual(["art_api", "art_mine"])
        expect(await ids({ projectId, owner: otherOwner })).toEqual(["art_theirs"])
        expect(await ids({ projectId, threadId: "thr_1" })).toEqual(["art_mine"])
        expect(await ids({ projectId, threadId: "thr_3" })).toEqual(["art_api"])
        expect(await ids({ projectId, owner, threadId: "thr_2" })).toEqual([])
        expect(await ids({ projectId: otherProjectId })).toEqual(["art_elsewhere"])
      })
    })

    // Regression proof: drop `sharedIn` from the in-memory publish, or the link insert from a SQL
    // provider's; the revised artifact is then not shared in thr_2.
    test("shares an artifact in each thread a write came from, after the next write too", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput({ id: "art_mine" }))
        await artifacts.publish(
          publishInput(
            { origin: { threadId: "thr_2", runId: "run_2" }, updatedAt: at(1) },
            "art_mine"
          )
        )
        await artifacts.publish(publishInput({ origin: undefined, updatedAt: at(2) }, "art_mine"))
        expect(await artifacts.listThreadIds({ projectId, id: "art_mine" })).toEqual([
          "thr_1",
          "thr_2",
        ])
        expect(
          (await artifacts.list({ projectId, threadId: "thr_2" })).artifacts.map(
            (artifact) => artifact.id
          )
        ).toEqual(["art_mine"])

        await artifacts.delete({ projectId, id: "art_mine" })
        expect(await artifacts.listThreadIds({ projectId, id: "art_mine" })).toEqual([])
        await artifacts.create(
          createInput({ id: "art_mine", version: versionInput({ origin: undefined }) })
        )
        expect(await artifacts.listThreadIds({ projectId, id: "art_mine" })).toEqual([])
      })
    })

    // Regression proof: take a restore point on every write of a turn in a provider's `publish`;
    // the turn then keeps three, the last two of its own content.
    test("keeps a restore point before a turn's first write to an artifact, once per turn", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput({ version: versionInput({ origin: undefined }) }))
        await artifacts.publish({
          ...publishInput({ title: "First", updatedAt: at(1) }),
          turnRunId: "run_1",
        })
        await artifacts.publish({
          ...publishInput({ title: "Second", updatedAt: at(2) }),
          turnRunId: "run_1",
        })
        // A sub-agent of the turn writes as the turn.
        await artifacts.publish({
          ...publishInput({
            title: "Third",
            origin: { threadId: "thr_1", runId: "run_child" },
            updatedAt: at(3),
          }),
          turnRunId: "run_1",
        })

        const points = await artifacts.listRestorePoints({ projectId, id: "art_report" })
        expect(points).toEqual([
          {
            projectId,
            artifactId: "art_report",
            revision: 1,
            version: 1,
            frozen: false,
            ...versionInput({ origin: undefined }),
            reason: "turn",
            turnRunId: "run_1",
            createdAt: at(1),
          },
        ])
        expect(
          await artifacts.getRestorePoint({ projectId, artifactId: "art_report", revision: 1 })
        ).toEqual(points[0] ?? null)
        expect(
          await artifacts.getRestorePoint({ projectId, artifactId: "art_report", revision: 2 })
        ).toBeNull()

        // Writes outside a turn keep none; a created artifact has nothing to go back to.
        await artifacts.publish(publishInput({ updatedAt: at(4) }))
        await artifacts.create({ ...createInput({ id: "art_new" }), turnRunId: "run_2" })
        expect(await artifacts.listRestorePoints({ projectId, id: "art_new" })).toEqual([])

        // Another turn keeps its own, of the frozen version it opens the next one past.
        await artifacts.freeze({
          projectId,
          artifactId: "art_report",
          frozenAt: at(5),
          frozenBy: otherOwner,
        })
        await artifacts.publish({ ...publishInput({ updatedAt: at(6) }), turnRunId: "run_3" })
        const [newest] = await artifacts.listRestorePoints({ projectId, id: "art_report" })
        expect(newest).toMatchObject({
          revision: 6,
          version: 1,
          frozen: true,
          title: "Q3 report",
          turnRunId: "run_3",
        })

        expect(await artifacts.listTurnWrites({ projectId, turnRunId: "run_1" })).toEqual([
          { artifactId: "art_report", created: false, revision: 4, writes: 3 },
        ])
        expect(await artifacts.listTurnWrites({ projectId, turnRunId: "run_2" })).toEqual([
          { artifactId: "art_new", created: true, revision: 1, writes: 1 },
        ])
        expect(
          await artifacts.listTurnWrites({ projectId: otherProjectId, turnRunId: "run_1" })
        ).toEqual([])
      })
    })

    // Regression proof: drop the prune after the insert in a provider's restore point; the
    // artifact then keeps one more.
    test(`keeps an artifact's last ${ARTIFACT_RESTORE_POINTS} restore points`, async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        for (let turn = 1; turn <= ARTIFACT_RESTORE_POINTS + 1; turn++) {
          await artifacts.publish({
            ...publishInput({ updatedAt: at(turn) }),
            turnRunId: `run_${turn}`,
          })
        }

        const points = await artifacts.listRestorePoints({ projectId, id: "art_report" })
        expect(points).toHaveLength(ARTIFACT_RESTORE_POINTS)
        expect(points[0]?.revision).toBe(ARTIFACT_RESTORE_POINTS + 1)
        expect(points.at(-1)?.revision).toBe(2)
      })
    })

    test("restores a restore point into the latest version, keeping what it replaces", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        await artifacts.publish({
          ...publishInput({ title: "Agent's", updatedAt: at(1) }),
          turnRunId: "run_1",
        })

        const restored = await artifacts.restoreTo({
          projectId,
          artifactId: "art_report",
          revision: 1,
          baseRevision: 2,
          author: otherOwner,
          restoredAt: at(2),
        })
        expect(restored.artifact).toMatchObject({
          latestVersion: 1,
          revision: 3,
          title: "Q3 report",
          updatedAt: at(2),
        })
        expect(restored.version).toMatchObject({
          version: 1,
          revision: 3,
          title: "Q3 report",
          author: otherOwner,
          updatedAt: at(2),
        })
        expect(restored.version).not.toHaveProperty("origin")

        // The restore can be undone: what it replaced is a restore point too.
        const [before] = await artifacts.listRestorePoints({ projectId, id: "art_report" })
        expect(before).toMatchObject({
          revision: 2,
          title: "Agent's",
          reason: "restore",
          createdAt: at(2),
        })
        expect(before).not.toHaveProperty("turnRunId")

        // A frozen version stays: restoring opens the next one.
        await artifacts.freeze({
          projectId,
          artifactId: "art_report",
          frozenAt: at(3),
          frozenBy: otherOwner,
        })
        const reopened = await artifacts.restoreTo({
          projectId,
          artifactId: "art_report",
          revision: 2,
          author: owner,
          restoredAt: at(4),
        })
        expect(reopened.version).toMatchObject({ version: 2, revision: 5, title: "Agent's" })
        expect(
          (await artifacts.getVersion({ projectId, artifactId: "art_report", version: 1 }))
            ?.frozenAt
        ).toEqual(at(3))

        await expectArtifactError(
          artifacts.restoreTo({
            projectId,
            artifactId: "art_report",
            revision: 9,
            author: owner,
            restoredAt: at(5),
          }),
          "restore_point_not_found"
        )
        await expectArtifactError(
          artifacts.restoreTo({
            projectId,
            artifactId: "art_report",
            revision: 1,
            baseRevision: 4,
            author: owner,
            restoredAt: at(5),
          }),
          "artifact_moved"
        )
        await expectArtifactError(
          artifacts.restoreTo({
            projectId,
            artifactId: "art_missing",
            revision: 1,
            author: owner,
            restoredAt: at(5),
          }),
          "artifact_not_found"
        )
      })
    })

    // Regression proof: skip the revision check in a provider's `undoTurnWrites`; the person's
    // edit to art_edited is then lost.
    test("undoes a retried turn's writes to what nobody changed since", async () => {
      await withStorage(async (artifacts) => {
        const turn = { threadId: "thr_turn", runId: "run_turn" }
        const write = (artifactId: string, overrides: Partial<ArtifactVersionInput> = {}) =>
          artifacts.publish({
            ...publishInput(
              { title: "Turn's", origin: turn, updatedAt: at(1), ...overrides },
              artifactId
            ),
            turnRunId: "run_turn",
          })

        // Replaced in place: back to what it held, by whoever wrote it.
        await artifacts.create(
          createInput({ id: "art_open", version: versionInput({ author: otherOwner }) })
        )
        await write("art_open")
        await write("art_open", { title: "Turn's again", updatedAt: at(2) })

        // Opened past a frozen version: the version it opened goes.
        await artifacts.create(createInput({ id: "art_frozen" }))
        await artifacts.freeze({
          projectId,
          artifactId: "art_frozen",
          frozenAt: at(1),
          frozenBy: otherOwner,
        })
        await write("art_frozen")

        // Changed since by someone else: it keeps the change.
        await artifacts.create(createInput({ id: "art_edited" }))
        await write("art_edited")
        await artifacts.publish(
          publishInput({ title: "Person's", origin: undefined, updatedAt: at(3) }, "art_edited")
        )

        // Created by the turn: it goes, with its frame grants, unless changed since.
        await artifacts.create({
          ...createInput({ id: "art_created", version: versionInput({ origin: turn }) }),
          turnRunId: "run_turn",
        })
        await artifacts.createFrameGrant(frameGrant("a", { artifactId: "art_created" }))
        await artifacts.create({
          ...createInput({ id: "art_kept", version: versionInput({ origin: turn }) }),
          turnRunId: "run_turn",
        })
        await artifacts.freeze({
          projectId,
          artifactId: "art_kept",
          frozenAt: at(3),
          frozenBy: otherOwner,
        })

        expect(
          await artifacts.undoTurnWrites({ projectId: otherProjectId, turnRunId: "run_turn" })
        ).toEqual({ restored: [], deleted: [] })
        const undone = await artifacts.undoTurnWrites({ projectId, turnRunId: "run_turn" })

        expect(undone.deleted).toEqual(["art_created"])
        expect(undone.restored.map(({ artifact }) => artifact.id).sort()).toEqual([
          "art_frozen",
          "art_open",
        ])

        const open = await artifacts.getVersion({ projectId, artifactId: "art_open", version: 1 })
        expect(open).toMatchObject({
          title: "Q3 report",
          author: otherOwner,
          origin: agentRun,
          revision: 4,
          updatedAt: t0,
          createdAt: t0,
        })
        expect(await artifacts.get({ projectId, id: "art_open" })).toMatchObject({
          title: "Q3 report",
          latestVersion: 1,
          revision: 4,
          updatedAt: t0,
        })
        expect(undone.restored.find(({ artifact }) => artifact.id === "art_open")?.version).toEqual(
          open ?? undefined
        )

        expect(await artifacts.get({ projectId, id: "art_frozen" })).toMatchObject({
          latestVersion: 1,
          revision: 4,
          updatedAt: at(1),
        })
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_frozen", version: 2 })
        ).toBeNull()
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_frozen", version: 1 })
        ).toMatchObject({ revision: 4, frozenAt: at(1) })
        // A version number is never reused: an address that named version 2 never lands on other content.
        expect(
          (await artifacts.publish(publishInput({ updatedAt: at(4) }, "art_frozen"))).version
            .version
        ).toBe(3)

        expect(await artifacts.get({ projectId, id: "art_edited" })).toMatchObject({
          title: "Person's",
          revision: 3,
        })
        expect(await artifacts.get({ projectId, id: "art_created" })).toBeNull()
        expect(await artifacts.findFrameGrant({ projectId, tokenHash: "a".repeat(64) })).toBeNull()
        expect(await artifacts.get({ projectId, id: "art_kept" })).not.toBeNull()

        // Undone to it, the turn's restore point is gone; one it was not undone to stays.
        expect(await artifacts.listRestorePoints({ projectId, id: "art_open" })).toEqual([])
        expect(
          (await artifacts.listRestorePoints({ projectId, id: "art_edited" })).map(
            (point) => point.turnRunId
          )
        ).toEqual(["run_turn"])
        expect(await artifacts.listTurnWrites({ projectId, turnRunId: "run_turn" })).toEqual([])
        // A second retry finds nothing left to undo.
        expect(await artifacts.undoTurnWrites({ projectId, turnRunId: "run_turn" })).toEqual({
          restored: [],
          deleted: [],
        })
      })
    })

    // Regression proof: compare the artifact's revision with the turn's last write alone, as
    // providers once did; the version created between the turn's writes is rewritten, and the
    // person's save between them is lost with no restore point of it.
    test("keeps what anyone changed between two of a turn's writes", async () => {
      await withStorage(async (artifacts) => {
        const write = (artifactId: string, updatedAt: Date) =>
          artifacts.publish({
            ...publishInput(
              { title: "Turn's", origin: { threadId: "thr_turn", runId: "run_turn" }, updatedAt },
              artifactId
            ),
            turnRunId: "run_turn",
          })

        // Someone created version 1 between the turn's writes: the second opened version 2.
        await artifacts.create(createInput({ id: "art_created_between" }))
        await write("art_created_between", at(1))
        await artifacts.freeze({
          projectId,
          artifactId: "art_created_between",
          frozenAt: at(2),
          frozenBy: otherOwner,
        })
        await write("art_created_between", at(3))

        // Someone saved between them, and the turn wrote again on top.
        await artifacts.create(createInput({ id: "art_saved_between" }))
        await write("art_saved_between", at(1))
        await artifacts.publish(
          publishInput(
            { title: "Person's", origin: undefined, updatedAt: at(2) },
            "art_saved_between"
          )
        )
        await write("art_saved_between", at(3))

        expect(await artifacts.listTurnWrites({ projectId, turnRunId: "run_turn" })).toEqual([
          { artifactId: "art_created_between", created: false, revision: 4, writes: 2 },
          { artifactId: "art_saved_between", created: false, revision: 4, writes: 2 },
        ])
        expect(await artifacts.undoTurnWrites({ projectId, turnRunId: "run_turn" })).toEqual({
          restored: [],
          deleted: [],
        })

        // Version 1 stays as its creator created it, and version 2 stays open.
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_created_between", version: 1 })
        ).toMatchObject({ title: "Turn's", frozenAt: at(2), frozenBy: otherOwner })
        expect(await artifacts.get({ projectId, id: "art_created_between" })).toMatchObject({
          latestVersion: 2,
          revision: 4,
        })
        // The turn's write on top of the save stays, and the turn's restore point with it.
        expect(await artifacts.get({ projectId, id: "art_saved_between" })).toMatchObject({
          title: "Turn's",
          revision: 4,
        })
        expect(
          (await artifacts.listRestorePoints({ projectId, id: "art_saved_between" })).map(
            (point) => point.turnRunId
          )
        ).toEqual(["run_turn"])
      })
    })

    // Regression proofs: keep every link in a provider's `undoTurnWrites`, and thr_5 keeps sharing
    // art_undone with nothing from it left; drop every link the turn made, and art_mine, kept
    // because someone wrote it since, vanishes from thr_2, which made it.
    test("unshares an undone artifact from the threads only a retried turn shared it in", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput({ id: "art_mine" }))
        await artifacts.publish({
          ...publishInput(
            { origin: { threadId: "thr_2", runId: "run_2" }, updatedAt: at(1) },
            "art_mine"
          ),
          turnRunId: "run_2",
        })
        await artifacts.publish({
          ...publishInput(
            { origin: { threadId: "thr_3", runId: "run_3" }, updatedAt: at(2) },
            "art_mine"
          ),
          turnRunId: "run_3",
        })
        await artifacts.publish({
          ...publishInput(
            { origin: { threadId: "thr_3", runId: "run_4" }, updatedAt: at(3) },
            "art_mine"
          ),
          turnRunId: "run_4",
        })

        // Changed since, the artifact keeps the link the retried turn made: it stays in the
        // conversation that made it.
        await artifacts.undoTurnWrites({ projectId, turnRunId: "run_2" })
        expect(await artifacts.listThreadIds({ projectId, id: "art_mine" })).toEqual([
          "thr_1",
          "thr_2",
          "thr_3",
        ])

        // Undone, it would leave the threads the turn shared it in; this one made no link.
        await artifacts.undoTurnWrites({ projectId, turnRunId: "run_4" })
        expect(await artifacts.listThreadIds({ projectId, id: "art_mine" })).toEqual([
          "thr_1",
          "thr_2",
          "thr_3",
        ])

        // Undone, an artifact the turn alone shared in thr_5 leaves it.
        await artifacts.create(
          createInput({ id: "art_undone", version: versionInput({ origin: undefined }) })
        )
        await artifacts.publish({
          ...publishInput(
            { origin: { threadId: "thr_5", runId: "run_5" }, updatedAt: at(4) },
            "art_undone"
          ),
          turnRunId: "run_5",
        })
        expect(await artifacts.listThreadIds({ projectId, id: "art_undone" })).toEqual(["thr_5"])
        await artifacts.undoTurnWrites({ projectId, turnRunId: "run_5" })
        expect(await artifacts.listThreadIds({ projectId, id: "art_undone" })).toEqual([])
        expect((await artifacts.list({ projectId, threadId: "thr_5" })).total).toBe(0)
      })
    })

    test("gives a copied version the outline the copy asks for, and the source keeps its own", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        await artifacts.freeze({
          projectId,
          artifactId: "art_report",
          frozenAt: at(1),
          frozenBy: otherOwner,
        })
        await artifacts.publish(publishInput({ title: "Second", updatedAt: at(2) }))
        const renamed = { kind: "document" as const, headings: [] }
        const seen: string[] = []

        await artifacts.copy({
          projectId,
          sourceId: "art_report",
          id: "art_copy",
          owner: otherOwner,
          threadId: "thr_fork",
          // Asked of each version as the copy holds it: under the copy's id.
          outlineOf: (version) => {
            seen.push(`${version.artifactId}@${version.version}`)
            return version.version === 2 ? renamed : undefined
          },
        })

        expect(seen.sort()).toEqual(["art_copy@1", "art_copy@2"])
        const outline = async (artifactId: string, version: number) =>
          (await artifacts.getVersion({ projectId, artifactId, version }))?.outline
        expect(await outline("art_copy", 2)).toEqual(renamed)
        expect(await outline("art_copy", 1)).toEqual(versionInput().outline)
        expect(await outline("art_report", 2)).toEqual(versionInput().outline)
      })
    })

    // Regression proof: copy only the latest version in a provider's `copy`; the copy then has no
    // version 1, and its next version is 2.
    test("copies an artifact with every version under its number, shared in one thread", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        await artifacts.freeze({
          projectId,
          artifactId: "art_report",
          frozenAt: at(1),
          frozenBy: otherOwner,
        })
        await artifacts.publish(
          publishInput({ title: "Second", author: otherOwner, updatedAt: at(2) })
        )
        await artifacts.freeze({
          projectId,
          artifactId: "art_report",
          frozenAt: at(3),
          frozenBy: otherOwner,
        })
        // Version 3 was a retried turn's: the copy numbers its next version 4, as the source does.
        await artifacts.publish({
          ...publishInput({
            title: "Retried",
            origin: { threadId: "thr_1", runId: "run_9" },
            updatedAt: at(4),
          }),
          turnRunId: "run_9",
        })
        await artifacts.undoTurnWrites({ projectId, turnRunId: "run_9" })
        await artifacts.publish(
          publishInput({ title: "Third", origin: undefined, updatedAt: at(5) })
        )

        const source = await artifacts.get({ projectId, id: "art_report" })
        const copy = await artifacts.copy({
          projectId,
          sourceId: "art_report",
          id: "art_copy",
          owner: otherOwner,
          threadId: "thr_fork",
          copiedAt: at(6),
        })
        expect(copy).toEqual({
          projectId,
          id: "art_copy",
          kind: "document",
          title: "Third",
          owner: otherOwner,
          latestVersion: 4,
          revision: source?.revision ?? 0,
          createdAt: t0,
          updatedAt: at(5),
        })

        const { versions } = await artifacts.listVersions({ projectId, artifactId: "art_copy" })
        expect(
          versions.map(({ version, title, author, frozenAt }) => ({
            version,
            title,
            author,
            frozenAt,
          }))
        ).toEqual([
          { version: 4, title: "Third", author: owner, frozenAt: undefined },
          { version: 2, title: "Second", author: otherOwner, frozenAt: at(3) },
          { version: 1, title: "Q3 report", author: owner, frozenAt: at(1) },
        ])
        // Without an origin, a retry of the source's turns never takes the copy's versions.
        expect(versions.every((version) => version.origin === undefined)).toBe(true)
        const latest = await artifacts.getVersion({
          projectId,
          artifactId: "art_report",
          version: 4,
        })
        expect(versions[0]?.files).toEqual(latest?.files ?? [])
        expect(versions[0]?.revision).toBe(latest?.revision ?? 0)
        // Restore points stay with the source.
        expect(await artifacts.listRestorePoints({ projectId, id: "art_copy" })).toEqual([])

        expect(await artifacts.listThreadIds({ projectId, id: "art_copy" })).toEqual(["thr_fork"])
        expect(await artifacts.listThreadIds({ projectId, id: "art_report" })).toEqual(["thr_1"])

        // A turn in the fork revises the copy, and a retry of it keeps the copy shared there.
        await artifacts.freeze({
          projectId,
          artifactId: "art_copy",
          frozenAt: at(7),
          frozenBy: otherOwner,
        })
        const revised = await artifacts.publish({
          ...publishInput({ origin: { threadId: "thr_fork", runId: "run_fork" } }, "art_copy"),
          turnRunId: "run_fork",
        })
        expect(revised.version.version).toBe(5)
        await artifacts.undoTurnWrites({ projectId, turnRunId: "run_fork" })
        expect(await artifacts.listThreadIds({ projectId, id: "art_copy" })).toEqual(["thr_fork"])

        await expectArtifactError(
          artifacts.copy({
            projectId,
            sourceId: "art_report",
            id: "art_copy",
            owner,
            threadId: "thr_fork",
          }),
          "artifact_exists"
        )
        await expectArtifactError(
          artifacts.copy({
            projectId,
            sourceId: "art_nope",
            id: "art_x",
            owner,
            threadId: "thr_x",
          }),
          "artifact_not_found"
        )
        expect(await artifacts.get({ projectId, id: "art_x" })).toBeNull()
      })
    })

    test("lists versions newest first, a page at a time", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        await artifacts.freeze({
          projectId,
          artifactId: "art_report",
          frozenAt: at(1),
          frozenBy: otherOwner,
        })
        await artifacts.publish(publishInput({ updatedAt: at(2) }))
        await artifacts.freeze({
          projectId,
          artifactId: "art_report",
          frozenAt: at(3),
          frozenBy: otherOwner,
        })
        await artifacts.publish(publishInput({ updatedAt: at(4) }))

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

    test("deletes an artifact with every version and restore point", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        await artifacts.publish({ ...publishInput({ updatedAt: at(1) }), turnRunId: "run_1" })

        expect(await artifacts.delete({ projectId: otherProjectId, id: "art_report" })).toBe(false)
        expect(await artifacts.delete({ projectId, id: "art_report" })).toBe(true)
        expect(await artifacts.get({ projectId, id: "art_report" })).toBeNull()
        expect(
          await artifacts.getVersion({ projectId, artifactId: "art_report", version: 1 })
        ).toBeNull()
        expect(await artifacts.delete({ projectId, id: "art_report" })).toBe(false)

        // The id is free again, and numbering starts over for the new artifact.
        expect((await artifacts.create(createInput())).version.version).toBe(1)
        expect(await artifacts.listRestorePoints({ projectId, id: "art_report" })).toEqual([])
        expect(await artifacts.listTurnWrites({ projectId, turnRunId: "run_1" })).toEqual([])
      })
    })

    test("keeps a value for each reader under its key, replacing one there", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        const mine = { projectId, artifactId: "art_report", principal: owner }
        const theirs = { ...mine, principal: otherOwner }
        await artifacts.setState({ ...mine, key: "rate", value: "412", updatedAt: at(1) })
        await artifacts.setState({
          ...mine,
          key: "filters",
          value: '{"region":"Lisboa ☀"}',
          updatedAt: at(1),
        })
        await artifacts.setState({ ...mine, key: "rate", value: "450", updatedAt: at(2) })
        await artifacts.setState({ ...theirs, key: "rate", value: "380", updatedAt: at(2) })

        expect(await artifacts.getState({ ...mine, key: "rate" })).toEqual({
          key: "rate",
          value: "450",
          sizeBytes: 3,
          updatedAt: at(2),
        })
        // Bytes as UTF-8: 21 characters, the sun three bytes of them.
        expect((await artifacts.getState({ ...mine, key: "filters" }))?.sizeBytes).toBe(23)
        expect((await artifacts.listState(mine)).map((entry) => entry.key)).toEqual([
          "filters",
          "rate",
        ])
        // Another reader keeps their own, and another project sees none.
        expect((await artifacts.getState({ ...theirs, key: "rate" }))?.value).toBe("380")
        expect(await artifacts.listState({ ...mine, projectId: otherProjectId })).toEqual([])
        expect(await artifacts.getState({ ...mine, key: "missing" })).toBeNull()

        expect(await artifacts.deleteState({ ...mine, key: "rate" })).toBe(true)
        expect(await artifacts.deleteState({ ...mine, key: "rate" })).toBe(false)
        expect(await artifacts.clearState(mine)).toBe(1)
        expect(await artifacts.listState(mine)).toEqual([])
        expect(await artifacts.listState(theirs)).toHaveLength(1)
        await expectArtifactError(
          artifacts.setState({
            ...mine,
            artifactId: "art_missing",
            key: "a",
            value: "1",
            updatedAt: at(3),
          }),
          "artifact_not_found"
        )
      })
    })

    test("refuses a value past the limits, counting a replaced value once", async () => {
      // Reproduce by dropping `checkArtifactStateWrite` from a provider's setState: the reader's
      // values grow past every limit.
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        const mine = { projectId, artifactId: "art_report", principal: owner }
        const value = (bytes: number) => JSON.stringify("x".repeat(bytes - 2))
        const set = (key: string, bytes: number) =>
          artifacts.setState({ ...mine, key, value: value(bytes), updatedAt: at(1) })

        await expectArtifactError(
          set("big", ARTIFACT_STATE_LIMITS.maxValueBytes + 1),
          "artifact_state_full"
        )
        await set("big", ARTIFACT_STATE_LIMITS.maxValueBytes)
        // Sixteen values of 64 KB are 1 MB: a seventeenth is past the reader's bytes, but the
        // sixteenth replaced is not.
        for (let index = 1; index < 16; index++)
          await set(`big-${index}`, ARTIFACT_STATE_LIMITS.maxValueBytes)
        await expectArtifactError(set("one-more", 2), "artifact_state_full")
        await set("big-15", ARTIFACT_STATE_LIMITS.maxValueBytes)
        await artifacts.clearState(mine)

        for (let index = 0; index < ARTIFACT_STATE_LIMITS.maxKeys; index++)
          await set(`key-${index}`, 4)
        await expectArtifactError(set("key-extra", 4), "artifact_state_full")
        await set("key-0", 8)
        // Another reader's limits are their own.
        await artifacts.setState({
          ...mine,
          principal: otherOwner,
          key: "key-extra",
          value: "1",
          updatedAt: at(1),
        })
        expect(await artifacts.getState({ ...mine, key: "key-extra" })).toBeNull()
      })
    })

    test("drops what an artifact keeps for its readers with the artifact", async () => {
      await withStorage(async (artifacts) => {
        await artifacts.create(createInput())
        const mine = { projectId, artifactId: "art_report", principal: owner }
        await artifacts.setState({ ...mine, key: "rate", value: "412", updatedAt: at(1) })
        await artifacts.delete({ projectId, id: "art_report" })
        await artifacts.create(createInput())
        // To see this fail, leave state out of `InMemoryArtifactStorage.deleteArtifact`.
        expect(await artifacts.listState(mine)).toEqual([])
      })
    })

    test("keeps a board's pictures by render key, mode, and size, the first one kept staying", async () => {
      await withStorage(async (artifacts) => {
        const welcome = "a".repeat(64)
        const region = "b".repeat(64)
        const picture = (
          renderKey: string,
          theme: "light" | "dark",
          size: "full" | "small",
          seed: string,
          createdAt = t0
        ) => ({
          renderKey,
          theme,
          size,
          file: fileRef(seed, size === "full" ? "image/png" : "image/webp"),
          createdAt,
        })
        await artifacts.putBoardPreviews({
          projectId,
          previews: [
            picture(region, "light", "full", "1"),
            picture(welcome, "dark", "small", "2"),
            picture(welcome, "light", "full", "3"),
            picture(welcome, "light", "small", "5"),
          ],
        })

        // A key names what the board shows: a second picture of it is of the same page.
        await artifacts.putBoardPreviews({
          projectId,
          previews: [picture(welcome, "light", "full", "4", at(1))],
        })

        expect(
          await artifacts.listBoardPreviews({ projectId, renderKeys: [region, welcome, "c"] })
        ).toEqual([
          { projectId, ...picture(welcome, "dark", "small", "2") },
          { projectId, ...picture(welcome, "light", "full", "3") },
          { projectId, ...picture(welcome, "light", "small", "5") },
          { projectId, ...picture(region, "light", "full", "1") },
        ])
        expect(await artifacts.listBoardPreviews({ projectId, renderKeys: [region] })).toHaveLength(
          1
        )
        expect(await artifacts.listBoardPreviews({ projectId, renderKeys: [] })).toEqual([])
        expect(
          await artifacts.listBoardPreviews({ projectId: otherProjectId, renderKeys: [welcome] })
        ).toEqual([])
      })
    })

    test("keeps a board's pictures when an artifact that showed it is deleted", async () => {
      await withStorage(async (artifacts) => {
        // Another version, of this artifact or a copy, may show the same board.
        await artifacts.create(createInput())
        const renderKey = "a".repeat(64)
        await artifacts.putBoardPreviews({
          projectId,
          previews: [
            {
              renderKey,
              theme: "light",
              size: "full",
              file: fileRef("1", "image/png"),
              createdAt: t0,
            },
          ],
        })

        expect(await artifacts.delete({ projectId, id: "art_report" })).toBe(true)
        expect(
          await artifacts.listBoardPreviews({ projectId, renderKeys: [renderKey] })
        ).toHaveLength(1)
      })
    })

    test("rolls back with its containing storage transaction", async () => {
      await withStorage(async (artifacts, storage) => {
        await artifacts.create(createInput())
        const rollback = new Error("rollback artifact publish")

        await expect(
          storage.transaction(async (tx) => {
            if (!tx.artifacts) throw new Error("Expected artifact storage in the transaction.")
            await tx.artifacts.publish({
              ...publishInput({ updatedAt: at(1) }),
              turnRunId: "run_1",
            })
            await tx.artifacts.freeze({
              projectId,
              artifactId: "art_report",
              frozenAt: at(1),
              frozenBy: otherOwner,
            })
            await tx.artifacts.create(createInput({ id: "art_rolled_back" }))
            await tx.artifacts.createFrameGrant(frameGrant("a"))
            await tx.artifacts.putBoardPreviews({
              projectId,
              previews: [
                {
                  renderKey: "a".repeat(64),
                  theme: "light",
                  size: "full",
                  file: fileRef("1", "image/png"),
                  createdAt: t0,
                },
              ],
            })
            await tx.artifacts.setState({
              projectId,
              artifactId: "art_report",
              principal: owner,
              key: "rate",
              value: "450",
              updatedAt: at(1),
            })
            expect((await tx.artifacts.get({ projectId, id: "art_report" }))?.revision).toBe(3)
            throw rollback
          })
        ).rejects.toBe(rollback)

        expect((await artifacts.get({ projectId, id: "art_report" }))?.revision).toBe(1)
        expect(await artifacts.get({ projectId, id: "art_rolled_back" })).toBeNull()
        // To see this fail, leave restore points out of `InMemoryArtifactStorage.restore`.
        expect(await artifacts.listRestorePoints({ projectId, id: "art_report" })).toEqual([])
        // To see this fail, leave frame grants out of `InMemoryArtifactStorage.restore`.
        expect(await artifacts.findFrameGrant({ projectId, tokenHash: "a".repeat(64) })).toBeNull()
        // To see this fail, leave board previews out of `InMemoryArtifactStorage.restore`.
        expect(
          await artifacts.listBoardPreviews({ projectId, renderKeys: ["a".repeat(64)] })
        ).toEqual([])
        // To see this fail, leave state out of `InMemoryArtifactStorage.restore`.
        expect(
          await artifacts.listState({ projectId, artifactId: "art_report", principal: owner })
        ).toEqual([])
        expect((await artifacts.publish(publishInput({ updatedAt: at(2) }))).version).toMatchObject(
          { version: 1, revision: 2 }
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

function publishInput(
  overrides: Partial<ArtifactVersionInput> = {},
  artifactId = "art_report"
): PublishArtifactVersionInput {
  return {
    projectId,
    artifactId,
    kind: "document",
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
    updatedAt: t0,
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
    revision: 1,
    targets: [
      {
        address: "artifact:art_other/figures/revenue.svg",
        artifactId: "art_other",
        version: 3,
        revision: 5,
      },
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
