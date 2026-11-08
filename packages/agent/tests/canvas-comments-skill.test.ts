import { describe, expect, test } from "bun:test"
import { renderInstanceHelp } from "@sixb/cli-core"
import { quoteArtifactComment } from "@sixb/core/artifacts"
import { BUILT_IN_SKILLS } from "../src/skills/built-in"

// What the canvas guide teaches the Agent about comments, held to what the app sends it and to the
// commands its sandbox has.

function canvasGuide(): string {
  const skill = BUILT_IN_SKILLS.find((candidate) => candidate.name === "sixb-artifacts")
  return String(skill?.files.find((file) => file.path === "canvas.md")?.contents)
}

describe("the canvas guide's comments", () => {
  // Guard proof: drop the comment's id from quoteArtifactComment; the guide's example no longer
  // matches what the app sends, and the Agent has no id to resolve.
  test("show a quoted comment as the app writes it, its id included", () => {
    const quoted = quoteArtifactComment({
      id: "cmt_4k2a9c0d1e",
      anchor: {
        board: "welcome",
        element: "body>main:0>h1:0",
        label: "Welcome back",
        revision: 12,
      },
      body: "Make the title warmer.",
    })
    expect(canvasGuide()).toContain(quoted)
  })

  test("resolve a comment once its change is made, and reply to one that can't be", () => {
    const guide = canvasGuide()
    expect(guide).toContain("sixb artifacts comments resolve <artifact-id> <comment-id>")
    expect(guide).toContain('sixb artifacts comments reply <artifact-id> <comment-id> "<why>"')

    // The sandbox's CLI has the commands the guide names.
    expect(renderInstanceHelp()).toContain("sixb artifacts comments resolve|reply")
  })
})
