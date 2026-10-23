import { describe, expect, test } from "bun:test"
import type { Principal } from "../auth"
import {
  type AgentMemoryChange,
  type AgentMemoryStore,
  type AgentStorage,
  AgentStorageError,
  type SaveAgentMemoryInput,
} from "../storage/agents"

export interface AgentMemoryStorageContractStorage {
  readonly agents: AgentStorage
}

export interface AgentMemoryStorageContractSuiteOptions<
  TStorage extends AgentMemoryStorageContractStorage = AgentMemoryStorageContractStorage,
> {
  /** Returns a fresh, empty storage bundle for every test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const projectId = "memory-contract"
const otherProjectId = "memory-contract-other"
const repoId = "user:usr_priya"
const author: Principal = { type: "user", id: "usr_priya" }
const t0 = new Date("2026-10-13T10:00:00.000Z")
const day = 24 * 60 * 60 * 1000

/** Provider-neutral persistence contract for Agent memory repos and their revisions. */
export function runAgentMemoryStorageContractSuite<
  TStorage extends AgentMemoryStorageContractStorage,
>(label: string, options: AgentMemoryStorageContractSuiteOptions<TStorage>): void {
  const withMemory = async (run: (memory: AgentMemoryStore) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage.agents.memory)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe(label, () => {
    test("reads a repo that was never saved as revision 0 with no files", async () => {
      await withMemory(async (memory) => {
        expect(await memory.get({ projectId, repoId })).toEqual({ revision: 0, files: [] })
        expect(await memory.listRevisions({ projectId, repoId })).toEqual({
          revisions: [],
          hasMore: false,
          total: 0,
        })
      })
    })

    test("stores a save as the next revision and reads its files back by path", async () => {
      await withMemory(async (memory) => {
        const saved = await memory.save(
          save({
            message: "Remember Priya prefers short bullet summaries",
            source: "/agents/thr_8f2",
            changes: [
              { path: "MEMORY.md", contents: "# Memory\n" },
              { path: "projects/payments.md", contents: "- Invoices exclude VAT\n" },
              { path: "metrics/keep_rate.sql", contents: "SELECT 1\n" },
            ],
          })
        )

        expect(saved).toEqual({ saved: true, revision: 1 })
        expect(await memory.get({ projectId, repoId })).toEqual({
          revision: 1,
          files: [
            { path: "MEMORY.md", contents: "# Memory\n" },
            { path: "metrics/keep_rate.sql", contents: "SELECT 1\n" },
            { path: "projects/payments.md", contents: "- Invoices exclude VAT\n" },
          ],
        })
        expect(await memory.listRevisions({ projectId, repoId })).toEqual({
          revisions: [
            {
              revision: 1,
              message: "Remember Priya prefers short bullet summaries",
              author,
              source: "/agents/thr_8f2",
              changes: [
                { path: "MEMORY.md", deleted: false },
                { path: "metrics/keep_rate.sql", deleted: false },
                { path: "projects/payments.md", deleted: false },
              ],
              createdAt: t0,
            },
          ],
          hasMore: false,
          total: 1,
        })
      })
    })

    test("keeps the files a save does not change and drops the ones it deletes", async () => {
      await withMemory(async (memory) => {
        await memory.save(save({ changes: [file("MEMORY.md"), file("a.md"), file("b.md")] }))
        const saved = await memory.save(
          save({
            baseRevision: 1,
            message: "Forget b",
            changes: [file("a.md", "updated"), { path: "b.md", contents: null }],
            createdAt: new Date(t0.getTime() + 1000),
          })
        )

        expect(saved).toEqual({ saved: true, revision: 2 })
        expect(await memory.get({ projectId, repoId })).toEqual({
          revision: 2,
          files: [file("MEMORY.md"), file("a.md", "updated")],
        })
        const { revisions } = await memory.listRevisions({ projectId, repoId })
        expect(revisions.map((revision) => [revision.revision, revision.changes])).toEqual([
          [
            2,
            [
              { path: "a.md", deleted: false },
              { path: "b.md", deleted: true },
            ],
          ],
          [
            1,
            [
              { path: "MEMORY.md", deleted: false },
              { path: "a.md", deleted: false },
              { path: "b.md", deleted: false },
            ],
          ],
        ])
        expect(revisions[0]).not.toHaveProperty("source")
      })
    })

    test("rejects a save of a file another save changed since its base revision", async () => {
      await withMemory(async (memory) => {
        await memory.save(save({ changes: [file("MEMORY.md"), file("findings.md")] }))
        await memory.save(save({ baseRevision: 1, changes: [file("findings.md", "theirs")] }))

        const rejected = await memory.save(
          save({ baseRevision: 1, changes: [file("findings.md", "mine"), file("new.md")] })
        )

        expect(rejected).toEqual({
          saved: false,
          revision: 2,
          conflicts: [file("findings.md", "theirs")],
        })
        expect(await memory.get({ projectId, repoId })).toEqual({
          revision: 2,
          files: [file("MEMORY.md"), file("findings.md", "theirs")],
        })
      })
    })

    test("reports a file another save deleted as a conflict with no contents", async () => {
      await withMemory(async (memory) => {
        await memory.save(save({ changes: [file("MEMORY.md"), file("old.md")] }))
        await memory.save(save({ baseRevision: 1, changes: [{ path: "old.md", contents: null }] }))

        expect(
          await memory.save(save({ baseRevision: 1, changes: [file("old.md", "mine")] }))
        ).toEqual({ saved: false, revision: 2, conflicts: [{ path: "old.md", contents: null }] })
      })
    })

    test("saves from the same base revision when they change different files", async () => {
      await withMemory(async (memory) => {
        await memory.save(save({ changes: [file("MEMORY.md")] }))

        expect(await memory.save(save({ baseRevision: 1, changes: [file("a.md")] }))).toEqual({
          saved: true,
          revision: 2,
        })
        expect(await memory.save(save({ baseRevision: 1, changes: [file("b.md")] }))).toEqual({
          saved: true,
          revision: 3,
        })
        expect((await memory.get({ projectId, repoId })).files.map((f) => f.path)).toEqual([
          "MEMORY.md",
          "a.md",
          "b.md",
        ])
      })
    })

    test("gives racing saves distinct revisions and lets only one write a shared file", async () => {
      await withMemory(async (memory) => {
        await memory.save(save({ changes: [file("MEMORY.md")] }))

        const disjoint = await Promise.all(
          ["a.md", "b.md", "c.md"].map((path) =>
            memory.save(save({ baseRevision: 1, changes: [file(path)] }))
          )
        )
        expect(disjoint.map((result) => result.revision).sort()).toEqual([2, 3, 4])

        const shared = await Promise.all(
          ["one", "two"].map((contents) =>
            memory.save(save({ baseRevision: 4, changes: [file("shared.md", contents)] }))
          )
        )
        expect(shared.filter((result) => result.saved)).toHaveLength(1)
        expect(shared.filter((result) => !result.saved)).toHaveLength(1)
        expect((await memory.get({ projectId, repoId })).revision).toBe(5)
      })
    })

    test("rejects every change of a save whose base revision is ahead of the repo", async () => {
      await withMemory(async (memory) => {
        await memory.save(save({ changes: [file("MEMORY.md"), file("a.md")] }))
        await memory.delete({ projectId, repoId })

        expect(
          await memory.save(
            save({ baseRevision: 1, changes: [file("a.md", "mine"), file("b.md")] })
          )
        ).toEqual({
          saved: false,
          revision: 0,
          conflicts: [
            { path: "a.md", contents: null },
            { path: "b.md", contents: null },
          ],
        })
      })
    })

    test("deletes a repo with its history, and the next save starts at revision 1", async () => {
      await withMemory(async (memory) => {
        await memory.save(save({ changes: [file("MEMORY.md")] }))
        await memory.save(save({ baseRevision: 1, changes: [file("a.md")] }))
        await memory.delete({ projectId, repoId })

        expect(await memory.get({ projectId, repoId })).toEqual({ revision: 0, files: [] })
        expect((await memory.listRevisions({ projectId, repoId })).total).toBe(0)
        expect(await memory.save(save({ changes: [file("MEMORY.md")] }))).toEqual({
          saved: true,
          revision: 1,
        })
      })
    })

    test("keeps repos apart by project and by repo id", async () => {
      await withMemory(async (memory) => {
        await memory.save(save({ changes: [file("MEMORY.md", "priya")] }))
        await memory.save(save({ repoId: "project", changes: [file("MEMORY.md", "project")] }))
        await memory.save(
          save({ projectId: otherProjectId, changes: [file("MEMORY.md", "other")] })
        )
        await memory.delete({ projectId: otherProjectId, repoId })

        expect(await memory.get({ projectId, repoId })).toEqual({
          revision: 1,
          files: [file("MEMORY.md", "priya")],
        })
        expect(await memory.get({ projectId, repoId: "project" })).toEqual({
          revision: 1,
          files: [file("MEMORY.md", "project")],
        })
        expect(await memory.get({ projectId: otherProjectId, repoId })).toEqual({
          revision: 0,
          files: [],
        })
      })
    })

    test("pages revisions newest first", async () => {
      await withMemory(async (memory) => {
        for (let revision = 0; revision < 3; revision += 1) {
          await memory.save(
            save({
              baseRevision: revision,
              message: `Save ${revision + 1}`,
              changes: [file("MEMORY.md", String(revision))],
              createdAt: new Date(t0.getTime() + revision * 1000),
            })
          )
        }

        const page = await memory.listRevisions({ projectId, repoId, limit: 2, offset: 1 })
        expect(page.revisions.map((revision) => revision.message)).toEqual(["Save 2", "Save 1"])
        expect(page).toMatchObject({ hasMore: false, total: 3 })
        expect(
          (await memory.listRevisions({ projectId, repoId, limit: 1 })).revisions.map(
            (revision) => revision.message
          )
        ).toEqual(["Save 3"])
      })
    })

    test("drops file versions older than 90 days once a newer version exists", async () => {
      await withMemory(async (memory) => {
        const at = (days: number) => new Date(t0.getTime() + days * day)
        await memory.save(
          save({ changes: [file("MEMORY.md", "v1"), file("kept.md"), file("gone.md")] })
        )
        await memory.save(
          save({
            baseRevision: 1,
            changes: [file("MEMORY.md", "v2"), { path: "gone.md", contents: null }],
            createdAt: at(10),
          })
        )
        // 90 days after revision 1, but not after revision 2.
        await memory.save(save({ baseRevision: 2, changes: [file("a.md")], createdAt: at(95) }))

        const { revisions } = await memory.listRevisions({ projectId, repoId })
        // Revision 1's versions of MEMORY.md and gone.md were replaced; kept.md's is still latest.
        expect(revisions.find((revision) => revision.revision === 1)?.changes).toEqual([
          { path: "kept.md", deleted: false },
        ])
        expect(revisions.find((revision) => revision.revision === 2)?.changes).toEqual([
          { path: "MEMORY.md", deleted: false },
          { path: "gone.md", deleted: true },
        ])
        expect(await memory.get({ projectId, repoId })).toEqual({
          revision: 3,
          files: [file("MEMORY.md", "v2"), file("a.md"), file("kept.md")],
        })
      })
    })

    test("rejects a save that names no change, repeats a path, or has a bad base", async () => {
      await withMemory(async (memory) => {
        for (const input of [
          save({ changes: [] }),
          save({ changes: [file("a.md"), file("a.md", "again")] }),
          save({ baseRevision: -1, changes: [file("a.md")] }),
          save({ message: "  ", changes: [file("a.md")] }),
        ]) {
          const rejected = await memory.save(input).catch((error: unknown) => error)
          expect(rejected).toBeInstanceOf(AgentStorageError)
          expect((rejected as AgentStorageError).code).toBe("invalid_input")
        }
        expect((await memory.get({ projectId, repoId })).revision).toBe(0)
      })
    })
  })
}

function save(overrides: Partial<SaveAgentMemoryInput>): SaveAgentMemoryInput {
  return {
    projectId,
    repoId,
    baseRevision: 0,
    message: "Remember something",
    author,
    changes: [],
    createdAt: t0,
    ...overrides,
  }
}

function file(path: string, contents = `${path}\n`): AgentMemoryChange & { contents: string } {
  return { path, contents }
}
