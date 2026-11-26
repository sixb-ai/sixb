import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { loadSixbFromEntry } from "../src/lib/loadSixb"

const CORE = resolve(import.meta.dir, "../../core/src/index.ts")

const directories: string[] = []

afterEach(async () => {
  delete process.env.SIXB_BRANCH

  while (directories.length > 0) {
    await rm(directories.pop()!, { recursive: true, force: true })
  }
})

/** A project whose config builds a plain host, off any branch. */
async function projectEntry(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sixb-load-branch-"))
  directories.push(directory)

  const entry = join(directory, "sixb.config.ts")
  await writeFile(
    entry,
    `import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from ${JSON.stringify(CORE)}

export const sixb = new SixbHost({
  id: "load-branch",
  ontology: [],
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
})
`
  )
  return entry
}

describe("loading a project", () => {
  test("starts a host that runs where the command was started", async () => {
    const host = await loadSixbFromEntry(await projectEntry())

    expect(host.branch).toBeNull()
  })

  // Guard check: return the imported host without `assertHostBranch` in `loadSixbFromEntry`
  // (`lib/loadSixb.ts`). This process loaded core before the variable was set, so its host runs
  // off the branch, as one a project built around the variables would.
  test("refuses a host that does not run as the branch the command was started for", async () => {
    const entry = await projectEntry()
    process.env.SIXB_BRANCH = "feature/invoices"

    const error = await loadSixbFromEntry(entry).catch((caught: unknown) => caught)

    expect(String(error)).toContain(
      `This command was started on branch "feature/invoices", but the project's host runs off any branch.`
    )
  })
})
