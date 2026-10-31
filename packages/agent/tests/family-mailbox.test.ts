import { describe, expect, test } from "bun:test"
import { ChildMailClosedError, FamilyMailbox } from "../src/family-mailbox"

// What a turn and the children it runs say to each other. The child-questions and child-messages
// suites in agent-worker prove the turn's tools and the child's inbox use it as the model sees it.

const signal = () => new AbortController().signal

describe("a turn's mailbox", () => {
  // Removal proof: drop the seen-id check in ChildBox.deliver; a replayed message_agent call is
  // read twice.
  test("gives a child its messages in order, each once however often it is sent", () => {
    const family = new FamilyMailbox()
    // Sent before the child's runner opened its side: it is there when it does.
    family.send("child-1", { id: "m1", kind: "message", text: "Skip Globex." })
    const box = family.child("child-1")
    family.send("child-1", { id: "m1", kind: "message", text: "Skip Globex." })
    family.send("child-1", { id: "m2", kind: "message", text: "Focus on terms." })

    expect(box.take()).toEqual([
      { id: "m1", text: "Skip Globex." },
      { id: "m2", text: "Focus on terms." },
    ])
    expect(box.take()).toEqual([])
  })

  // Removal proof: settle `ask` on any reply in ChildBox.deliver; a late answer to an earlier
  // question answers the one the child asks now.
  test("answers a question with the reply to it, and lists it only while it waits", async () => {
    const family = new FamilyMailbox()
    const box = family.child("child-1")
    const changed = family.changed()

    const reply = box.ask({ id: "q2", text: "Which region?" }, signal())
    await changed
    expect(family.questions()).toEqual([{ id: "q2", text: "Which region?", runId: "child-1" }])

    family.send("child-1", { id: "a1", kind: "answer", text: "North.", inReplyTo: "q1" })
    family.send("child-1", { id: "a2", kind: "answer", text: "West.", inReplyTo: "q2" })

    expect(await reply).toMatchObject({ kind: "answer", text: "West." })
    expect(family.questions()).toEqual([])
  })

  test("withdraws a question its child stopped waiting on", async () => {
    const family = new FamilyMailbox()
    const stop = new AbortController()
    const reply = family
      .child("child-1")
      .ask({ id: "q1", text: "Which?" }, stop.signal)
      .catch((error: unknown) => error)

    stop.abort(new DOMException("Cancelled.", "AbortError"))

    expect(await reply).toBeInstanceOf(DOMException)
    expect(family.question("child-1")).toBeUndefined()
  })

  // Removal proof: drop the closed check in ChildBox.deliver; a message sent as the child pauses
  // is accepted, and neither its pause nor its continuation ever reads it.
  test("returns what a child never read as it stops, and refuses what comes after", () => {
    const family = new FamilyMailbox()
    const box = family.child("child-1")
    family.send("child-1", { id: "m1", kind: "message", text: "Late." })

    expect(box.close()).toEqual([{ id: "m1", text: "Late." }])
    expect(() => family.send("child-1", { id: "m2", kind: "message", text: "Later." })).toThrow(
      ChildMailClosedError
    )
  })

  test("wakes the turn when a child ends, and drops the question it asked", async () => {
    const family = new FamilyMailbox()
    void family.child("child-1").ask({ id: "q1", text: "Which?" }, signal())
    const changed = family.changed()

    family.finished("child-1")

    await changed
    expect(family.questions()).toEqual([])
  })

  test("sends nothing once the turn ended", () => {
    const family = new FamilyMailbox()
    family.close()

    expect(() => family.send("child-1", { id: "m1", kind: "message", text: "Hi." })).toThrow(
      ChildMailClosedError
    )
  })
})
