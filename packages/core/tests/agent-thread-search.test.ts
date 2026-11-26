import { describe, expect, test } from "bun:test"
import { agent, can, defineGroup, defineRole, type EmbeddingModel, SixbHost } from "../src"
import { agentTurnVectorConfiguration } from "../src/agents/turn-vectors/configuration"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import { createTestAgentExecution } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "agent-thread-search"
const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const
const t0 = Date.parse("2026-11-20T09:00:00.000Z")

const agentUsers = defineGroup("agent-users")
const agentRunner = defineRole("agent.runner", {
  grantedTo: [agentUsers],
  grants: [can.run(agent)],
})

/** Invoices point east, everything else north: a search scores a turn 1 or 0. */
const embeddings: EmbeddingModel = {
  providerId: "test",
  modelId: "embeddings",
  definition: { kind: "embedding", providerId: "test", modelId: "embeddings", dimensions: 3 },
  async embed({ texts }) {
    return {
      vectors: texts.map((text) => (/invoice/i.test(text) ? [1, 0, 0] : [0, 1, 0])),
      usage: { inputTokens: 5 },
    }
  },
}

function at(seconds: number): Date {
  return new Date(t0 + seconds * 1000)
}

function setup(models: { readonly embedding?: readonly EmbeddingModel[] } = {}) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    models: { language: [testLanguageModel()], embedding: [...(models.embedding ?? [embeddings])] },
    groups: [agentUsers],
    roles: [agentRunner],
    ...deps,
  })
  return { host, storage: deps.storage }
}

type Host = ReturnType<typeof setup>["host"]
type Storage = ReturnType<typeof setup>["storage"]

/** A signed-in user's request, as the server binds one. */
async function signedIn(host: Host, id: string) {
  await host.storage.auth?.users.create({ projectId, id, email: `${id}@example.com` })

  const sessionId = `session-${id}`
  await host.storage.auth?.sessions.create({
    projectId,
    id: sessionId,
    userId: id,
    strategyId: "test",
    tokenHash: sessionId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  })

  return bindRequestExecution(host, {
    request: new Request("http://localhost/test"),
    authorization: {
      type: "principal",
      credential: { type: "session", id: sessionId },
      context: {
        principal: { type: "user", id },
        sessionId,
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true },
      },
    },
  })
}

/**
 * A conversation of `owner`'s, each turn a question and its answer, indexed as the background
 * indexing would: the turn's text embedded by the project's model.
 */
async function conversation(
  storage: Storage,
  threadId: string,
  input: {
    readonly owner: typeof alice | typeof bob
    readonly participants?: readonly (typeof alice | typeof bob)[]
    readonly title?: string
    /** A turn with `published` was answered by a run that published that artifact. */
    readonly turns: readonly {
      readonly seconds: number
      readonly text: string
      readonly published?: string
    }[]
  }
) {
  const agents = storage.agents
  await agents.threads.create({
    projectId,
    id: threadId,
    ownerPrincipal: input.owner,
    ...(input.title ? { title: input.title } : {}),
    createdAt: at(0),
  })
  if (input.participants) {
    await agents.threads.addParticipants({
      projectId,
      threadId,
      principals: input.participants,
      addedBy: input.owner,
      maxParticipants: 50,
    })
  }

  for (const [index, { seconds, text, published }] of input.turns.entries()) {
    const n = index + 1
    await agents.messages.append({
      id: `${threadId}_q${n}`,
      projectId,
      threadId,
      runId: null,
      role: "user",
      authorPrincipal: input.owner,
      parts: [{ type: "text", text }],
      createdAt: at(seconds),
    })

    const runId = published ? `${threadId}_run_${n}` : null
    if (runId && published) {
      await agents.runs.create({
        id: runId,
        projectId,
        executionId: await createTestAgentExecution(storage, { projectId, runId }),
        threadId,
        triggerMessageId: `${threadId}_q${n}`,
        spec: { model: { provider: "test", modelId: "test-model" } },
        createdAt: at(seconds),
      })
      await publish(storage, published, { threadId, runId, seconds })
    }

    await agents.messages.append({
      id: `${threadId}_a${n}`,
      projectId,
      threadId,
      runId,
      role: "assistant",
      parts: [{ type: "text", text: "Done." }],
      createdAt: at(seconds + 1),
    })
  }

  const configuration = agentTurnVectorConfiguration(embeddings)
  const progress = await agents.turnVectors.progress({ projectId, threadId, configuration })
  const { vectors } = await embeddings.embed({ texts: input.turns.map((turn) => turn.text) })
  await agents.turnVectors.write({
    projectId,
    threadId,
    configuration,
    revision: progress!.revision,
    fromSeq: 1,
    turns: input.turns.map(({ seconds, text }, index) => ({
      messageId: `${threadId}_q${index + 1}`,
      chunk: 0,
      firstSeq: 2 * index + 1,
      lastSeq: 2 * index + 2,
      turnAt: at(seconds),
      text: `Request: ${text}\n\nAnswer: Done.`,
      embedding: vectors[index]!,
    })),
    complete: true,
  })
}

/** An artifact a run published in its turn. */
async function publish(
  storage: Storage,
  title: string,
  turn: { readonly threadId: string; readonly runId: string; readonly seconds: number },
  as: { readonly id?: string; readonly owner?: typeof alice | typeof bob } = {}
) {
  const hex = "a".repeat(64)
  const owner = as.owner ?? alice
  await storage.artifacts.create({
    projectId,
    id: as.id ?? `art_${turn.runId}`,
    kind: "document",
    owner,
    turnRunId: turn.runId,
    version: {
      title,
      entry: "document.md",
      files: [
        {
          path: "document.md",
          file: {
            blobId: `blob_${hex}`,
            digest: `sha256:${hex}`,
            sizeBytes: 42,
            fileName: "document.md",
            mediaType: "text/markdown",
          },
        },
      ],
      outline: { kind: "document", headings: [] },
      references: [],
      author: owner,
      origin: { threadId: turn.threadId, runId: turn.runId },
      updatedAt: at(turn.seconds),
    },
  })
}

describe("sixb.agent.threads.search", () => {
  test("finds the caller's conversations and those shared with them, the best first", async () => {
    const { host, storage } = setup()
    await conversation(storage, "thr_mine", {
      owner: alice,
      title: "Invoices",
      turns: [
        { seconds: 10, text: "Plan the trip" },
        { seconds: 20, text: "Which invoices are late?" },
        { seconds: 30, text: "Draft the invoice reminder", published: "Invoice reminder" },
      ],
    })
    await conversation(storage, "thr_shared", {
      owner: bob,
      participants: [alice],
      turns: [{ seconds: 40, text: "Invoice totals for Q3" }],
    })
    // Bob's alone: Alice never reads it, whatever she could observe.
    await conversation(storage, "thr_bobs", {
      owner: bob,
      turns: [{ seconds: 50, text: "Invoice disputes" }],
    })

    // Recorded as the turn's write, but shared only in Bob's conversation: Alice cannot open it.
    // Guard proof: show every artifact the turn wrote in turnArtifacts; it is listed too.
    await publish(
      storage,
      "Bob's disputes",
      { threadId: "thr_bobs", runId: "thr_mine_run_3", seconds: 51 },
      { id: "art_bobs", owner: bob }
    )

    const sixb = await signedIn(host, alice.id)
    const result = await sixb.agent.threads.search({ text: "unpaid invoices" })

    expect(result.searchedFrom).toBeUndefined()
    expect(result.conversations).toEqual([
      {
        thread: { id: "thr_shared", createdAt: at(0), lastMessageAt: at(41), shared: true },
        score: 1,
        turns: [
          {
            messageId: "thr_shared_q1",
            firstSeq: 1,
            lastSeq: 2,
            at: at(40),
            score: 1,
            excerpt: "Request: Invoice totals for Q3\n\nAnswer: Done.",
            artifacts: [],
          },
        ],
      },
      {
        thread: expect.objectContaining({ id: "thr_mine", title: "Invoices", shared: false }),
        score: 1,
        turns: [
          expect.objectContaining({
            messageId: "thr_mine_q3",
            score: 1,
            artifacts: [{ id: "art_thr_mine_run_3", title: "Invoice reminder" }],
          }),
          expect.objectContaining({ messageId: "thr_mine_q2", score: 1, artifacts: [] }),
          expect.objectContaining({ messageId: "thr_mine_q1", score: 0 }),
        ],
      },
    ])

    // At most `limit` conversations, the best.
    const best = await sixb.agent.threads.search({ text: "unpaid invoices", limit: 1 })
    expect(best.conversations.map((found) => found.thread.id)).toEqual(["thr_shared"])

    // Within a window of when turns were asked.
    const window = await sixb.agent.threads.search({
      text: "unpaid invoices",
      since: at(15),
      until: at(40),
    })
    expect(
      window.conversations.flatMap((found) => found.turns.map((turn) => turn.messageId))
    ).toEqual(["thr_mine_q3", "thr_mine_q2"])
  })

  test("bills the query's embedding to the caller's execution", async () => {
    const { host, storage } = setup()
    const sixb = await signedIn(host, alice.id)

    await sixb.agent.threads.search({ text: "unpaid invoices" })

    await expect(
      storage.aiUsage.getLatestForExecution({ projectId, executionId: sixb.execution.id })
    ).resolves.toMatchObject({ usage: { inputTokens: 5 } })
  })

  test("says what it needs when it cannot search", async () => {
    const withoutModel = setup({ embedding: [] })
    const unavailable = await (await signedIn(withoutModel.host, alice.id)).agent.threads
      .search({ text: "unpaid invoices" })
      .catch((error: unknown) => error)
    expect(unavailable).toMatchObject({
      code: "agent.search_unavailable",
      message: expect.stringContaining("models.embedding"),
    })

    // Guard proof: drop the searchAvailable check; the search runs on storage that cannot.
    const { host, storage } = setup()
    storage.agents.turnVectors.searchAvailable = async () => false
    const refused = await (await signedIn(host, alice.id)).agent.threads
      .search({ text: "unpaid invoices" })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({
      code: "agent.search_unavailable",
      message: expect.stringContaining("pgvector"),
    })
  })

  test("refuses a search it cannot read before embedding anything", async () => {
    let embedded = 0
    const counting: EmbeddingModel = {
      ...embeddings,
      embed: async (input) => {
        embedded++
        return embeddings.embed(input)
      },
    }
    const { host } = setup({ embedding: [counting] })
    const sixb = await signedIn(host, alice.id)

    for (const input of [
      { text: "  " },
      { text: "x".repeat(8001) },
      { text: "invoices", since: at(20), until: at(10) },
      { text: "invoices", since: new Date(Number.NaN) },
      { text: "invoices", limit: 0 },
      { text: "invoices", limit: 26 },
    ]) {
      const error = await sixb.agent.threads.search(input).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: "invalid_search" })
    }

    // A valid one embeds, so the count above can move.
    await sixb.agent.threads.search({ text: "invoices", limit: 25 })
    expect(embedded).toBe(1)
  })
})
