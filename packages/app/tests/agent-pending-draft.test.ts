import { afterEach, describe, expect, test } from "bun:test"
import { keepAgentDraft, PENDING_DRAFT_MS, takeAgentDraft } from "../src/artifacts/view-context"
import { installDom } from "./helpers/dom"

// Words an artifact's own page asks the Agent wait in the tab for the conversation at home: for
// the same person, in the same project, a moment later, and once.

installDom(["sessionStorage"])
afterEach(() => sessionStorage.clear())

const ava = { userId: "usr_ava", projectId: "northline" }
const at = Date.parse("2026-11-08T09:00:00.000Z")

describe("words kept for the Agent", () => {
  test("are taken once, by the same person in the same project", () => {
    const context = {
      kind: "app-state" as const,
      id: "artifact-comments:art_1",
      label: "1 comment · Summer sale",
      description: "Comments the person chose.",
      value: { artifactId: "art_1", comments: [] },
    }
    keepAgentDraft({ ...ava, artifactId: "art_1", text: "Warmer title", context }, at)

    expect(takeAgentDraft(ava, at + 1_000)).toEqual({ text: "Warmer title", context })
    expect(takeAgentDraft(ava, at + 2_000)).toBeNull()
  })

  // Guard proof: drop the owner and time checks from takeAgentDraft; Bob's conversation, and a
  // conversation opened tomorrow, start with Ava's words.
  test("are dropped for anyone else, another project, or once they waited too long", () => {
    for (const [owner, now] of [
      [{ userId: "usr_bob", projectId: "northline" }, at + 1_000],
      [{ userId: null, projectId: "northline" }, at + 1_000],
      [{ userId: "usr_ava", projectId: "acme" }, at + 1_000],
      [ava, at + PENDING_DRAFT_MS + 1],
    ] as const) {
      keepAgentDraft({ ...ava, artifactId: "art_1", text: "Warmer title" }, at)
      expect(takeAgentDraft(owner, now)).toBeNull()
      // Dropped, not kept for someone else.
      expect(takeAgentDraft(ava, at + 1_000)).toBeNull()
    }
  })

  test("are dropped when what the tab holds is not theirs", () => {
    sessionStorage.setItem("sixb.agent.pending-draft", "Warmer title")
    expect(takeAgentDraft(ava, at)).toBeNull()
    expect(sessionStorage.getItem("sixb.agent.pending-draft")).toBeNull()
  })
})
