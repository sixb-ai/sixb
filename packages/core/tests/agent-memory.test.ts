import { describe, expect, test } from "bun:test"
import type { AgentMemoryErrorCode, AuthorizablePrincipal } from "../src"
import { AgentMemoryError, SixbHost } from "../src"
import {
  agentMemoryLinkPath,
  agentMemoryLinks,
  agentMemoryPathProblem,
  findBrokenAgentMemoryLinks,
} from "../src/agents/memory"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function setup() {
  const host = new SixbHost({ id: "memory", ontology: [], ...createTestRuntimeDeps() })
  const as = (
    principal: AuthorizablePrincipal,
    grants: { readonly agent?: boolean; readonly memory?: boolean } = { agent: true }
  ) =>
    createTestSixb(host, {
      authorization: {
        principal,
        groupIds: [],
        roleIds: [],
        grants: {
          ...emptyGrantIndex(),
          "run:agent": grants.agent ?? false,
          "manage:agentMemory": grants.memory ?? false,
        },
      },
    }).agent.memory
  const user = (id: string, grants?: { agent?: boolean; memory?: boolean }) =>
    as({ type: "user", id }, grants)
  return { host, as, user }
}

async function expectMemoryError(
  promise: Promise<unknown>,
  code: AgentMemoryErrorCode,
  message?: string
) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(AgentMemoryError)
  expect((error as AgentMemoryError).code).toBe(code)
  if (message) expect((error as Error).message).toContain(message)
}

const entry = (contents = "# Memory\n\n## Index\n") => ({ path: "MEMORY.md", contents })

describe("a user's memory", () => {
  test("is their own: saved and read back by them, invisible to anyone else", async () => {
    const { user } = setup()
    const priya = user("usr_priya")

    expect(await priya.get("user")).toEqual({ repo: "user", revision: 0, files: [] })
    expect(
      await priya.save("user", {
        baseRevision: 0,
        message: " Remember Priya prefers short bullet summaries ",
        source: "/agents/thr_8f2",
        changes: [entry("# Memory: Priya\n\n- Prefers short bullet summaries\n")],
      })
    ).toEqual({ saved: true, revision: 1, warnings: [] })

    expect(await priya.get("user")).toMatchObject({
      revision: 1,
      files: [entry("# Memory: Priya\n\n- Prefers short bullet summaries\n")],
    })
    expect((await priya.listRevisions("user")).revisions).toEqual([
      {
        revision: 1,
        message: "Remember Priya prefers short bullet summaries",
        author: { type: "user", id: "usr_priya" },
        source: "/agents/thr_8f2",
        changes: [{ path: "MEMORY.md", deleted: false }],
        createdAt: expect.any(Date),
      },
    ])
    expect(await user("usr_adam").get("user")).toMatchObject({ revision: 0, files: [] })
  })

  test("needs no grant, and is not reachable by a service account", async () => {
    const { user, as } = setup()
    const withoutGrants = user("usr_priya", {})

    await withoutGrants.save("user", { baseRevision: 0, message: "Start", changes: [entry()] })
    expect((await withoutGrants.get("user")).revision).toBe(1)

    await expectMemoryError(
      as({ type: "serviceAccount", id: "svc_agent_report" }).get("user"),
      "not_allowed",
      "belongs to a signed-in user"
    )
  })

  test("belongs to the one caller of a project without auth", async () => {
    const { host } = setup()
    const memory = () => createTestSixb(host).agent.memory

    await memory().save("user", { baseRevision: 0, message: "Start", changes: [entry()] })

    expect(await memory().get("user")).toMatchObject({ revision: 1 })
    expect((await memory().listRevisions("user")).revisions[0]?.author).toEqual({
      type: "system",
      id: "system",
    })
  })

  test("is deleted with its history", async () => {
    const { user } = setup()
    const priya = user("usr_priya")
    await priya.save("user", { baseRevision: 0, message: "Start", changes: [entry()] })

    await priya.delete("user")

    expect(await priya.get("user")).toMatchObject({ revision: 0, files: [] })
    expect((await priya.listRevisions("user")).total).toBe(0)
  })
})

describe("the project's memory", () => {
  test("is read and saved by everyone who can run the Agent, and deleted only with can.manage", async () => {
    const { user } = setup()
    const priya = user("usr_priya")
    const adam = user("usr_adam")
    const keeper = user("usr_keeper", { agent: true, memory: true })

    await priya.save("project", { baseRevision: 0, message: "Start", changes: [entry()] })
    await adam.save("project", {
      baseRevision: 1,
      message: "Dossier",
      changes: [{ path: "vocabulary.md", contents: "- A dossier is a Case\n" }],
    })

    expect(await keeper.get("project")).toMatchObject({ revision: 2 })
    expect((await priya.listRevisions("project")).revisions.map((r) => r.author.id)).toEqual([
      "usr_adam",
      "usr_priya",
    ])
    await expectMemoryError(priya.delete("project"), "not_allowed", "can.manage(agent.memory)")
    await expectMemoryError(user("usr_outsider", {}).get("project"), "not_allowed")
    await expectMemoryError(
      user("usr_outsider", {}).save("project", {
        baseRevision: 2,
        message: "X",
        changes: [entry()],
      }),
      "not_allowed"
    )
    await keeper.delete("project")
    expect(await priya.get("project")).toMatchObject({ revision: 0, files: [] })
  })

  test("is shared: a user's own repo is not the project's", async () => {
    const { user } = setup()
    const keeper = user("usr_keeper", { agent: true, memory: true })
    await keeper.save("project", { baseRevision: 0, message: "Shared", changes: [entry("# P\n")] })

    expect(await keeper.get("user")).toMatchObject({ revision: 0, files: [] })
  })
})

describe("saving", () => {
  test("reports a conflicting file as it is now and saves nothing", async () => {
    const { user } = setup()
    const priya = user("usr_priya")
    await priya.save("user", { baseRevision: 0, message: "Start", changes: [entry()] })
    await priya.save("user", {
      baseRevision: 1,
      message: "Theirs",
      changes: [{ path: "findings.md", contents: "theirs\n" }],
    })

    expect(
      await priya.save("user", {
        baseRevision: 1,
        message: "Mine",
        changes: [{ path: "findings.md", contents: "mine\n" }],
      })
    ).toEqual({
      saved: false,
      revision: 2,
      conflicts: [{ path: "findings.md", contents: "theirs\n" }],
    })
  })

  test("warns about links that point at no file", async () => {
    const { user } = setup()
    const saved = await user("usr_priya").save("user", {
      baseRevision: 0,
      message: "Start",
      changes: [
        entry("# Memory\n\n## Index\n- [[team_structure]]\n- [[projects/payments]]\n"),
        { path: "projects/payments.md", contents: "See [[metrics/keep_rate.sql]].\n" },
      ],
    })

    expect(saved).toEqual({
      saved: true,
      revision: 1,
      warnings: [
        { path: "MEMORY.md", link: "team_structure" },
        { path: "projects/payments.md", link: "metrics/keep_rate.sql" },
      ],
    })
  })

  test("rejects a save the Agent can fix, with what to change", async () => {
    const { user } = setup()
    const priya = user("usr_priya")
    const save = (message: string, changes: { path: string; contents: string | null }[]) =>
      priya.save("user", { baseRevision: 0, message, changes })

    await expectMemoryError(
      save("Topic", [{ path: "a.md", contents: "a" }]),
      "invalid_save",
      "MEMORY.md"
    )
    await expectMemoryError(save(" ", [entry()]), "invalid_save", "needs a message")
    await expectMemoryError(save("None", []), "invalid_save", "changes no file")
    await expectMemoryError(
      save("Escape", [entry(), { path: "../secrets.md", contents: "x" }]),
      "invalid_save",
      "'..'"
    )
    await expectMemoryError(
      save("Big", [entry("x".repeat(16 * 1024 + 1))]),
      "invalid_save",
      "Move entries into topic files and link them."
    )
    await expectMemoryError(
      save("Huge", [entry(), { path: "big.md", contents: "x".repeat(256 * 1024 + 1) }]),
      "invalid_save",
      "over 256 KB"
    )
    await expectMemoryError(
      save("Repo", [
        entry(),
        ...Array.from({ length: 17 }, (_, index) => ({
          path: `topic-${index}.md`,
          contents: "x".repeat(250 * 1024),
        })),
      ]),
      "invalid_save",
      "over 4 MB"
    )
    await expectMemoryError(
      priya.save("user", {
        baseRevision: 0,
        message: "Spoof",
        source: "https://example.com",
        changes: [entry()],
      }),
      "invalid_save",
      "/agents/<threadId>"
    )
    expect((await priya.get("user")).revision).toBe(0)
  })

  test("keeps MEMORY.md: a save cannot delete it", async () => {
    const { user } = setup()
    const priya = user("usr_priya")
    await priya.save("user", { baseRevision: 0, message: "Start", changes: [entry()] })

    await expectMemoryError(
      priya.save("user", {
        baseRevision: 1,
        message: "Forget all",
        changes: [{ path: "MEMORY.md", contents: null }],
      }),
      "invalid_save",
      "must keep its MEMORY.md"
    )
  })
})

describe("memory paths and links", () => {
  test("accepts relative POSIX paths and names what is wrong with the rest", () => {
    expect(agentMemoryPathProblem("projects/payments.md")).toBeNull()
    expect(agentMemoryPathProblem("metrics/autocomplete_keep_rate.sql")).toBeNull()
    expect(agentMemoryPathProblem("/MEMORY.md")).toContain("absolute")
    expect(agentMemoryPathProblem("a//b.md")).toContain("empty segment")
    expect(agentMemoryPathProblem("./a.md")).toContain("'.' or '..'")
    expect(agentMemoryPathProblem(".env")).toContain("dotfile")
    expect(agentMemoryPathProblem("notes/.hidden/a.md")).toContain("dotfile")
    expect(agentMemoryPathProblem("findings.md.theirs")).toContain("conflict copy")
    expect(agentMemoryPathProblem("a\\b.md")).toContain("backslash")
    expect(agentMemoryPathProblem("a\nb.md")).toContain("control character")
  })

  test("reads [[links]] as paths from the root, with .md left out", () => {
    expect(agentMemoryLinks("[[a]] and [[ b/c ]], again [[a]]; not [[]] or [[x\ny]]")).toEqual([
      "a",
      "b/c",
    ])
    expect(agentMemoryLinkPath("projects/payments")).toBe("projects/payments.md")
    expect(agentMemoryLinkPath("metrics/keep_rate.sql")).toBe("metrics/keep_rate.sql")
    expect(
      findBrokenAgentMemoryLinks([
        { path: "MEMORY.md", contents: "[[a]] [[gone]]" },
        { path: "a.md", contents: "" },
        { path: "query.sql", contents: "-- [[not a link in sql]]" },
      ])
    ).toEqual([{ path: "MEMORY.md", link: "gone" }])
  })
})
