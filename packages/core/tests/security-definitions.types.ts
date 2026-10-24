import {
  agent,
  can,
  col,
  currentUser,
  defineDataset,
  defineGroup,
  defineMembershipPolicy,
  defineObjectType,
  defineShare,
  every,
  type ObjectViewGrantBuilder,
  project,
  prop,
  ref,
  userRef,
  type ViewGrant,
} from "../src"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const securityAdmins = defineGroup("security-admins")
const commercial = defineGroup("commercial")

can.observe(project.logs)
can.observe(project.activity)
can.observe(agent.usage)
can.observe(agent.threads)
// @ts-expect-error conversations are observed, never managed.
can.manage(agent.threads)
// @ts-expect-error project surfaces use the typed project reference.
can.observe("logs")
// @ts-expect-error observe takes one of project's surfaces, not the project itself.
can.observe(project)
can.manage(agent.usage)
can.manage(agent.memory)
can.view(project.users)
// @ts-expect-error the member directory is read with can.view, not observed.
can.observe(project.users)
// @ts-expect-error logs are observed, not viewed.
can.view(project.logs)
// @ts-expect-error activity is observed, not viewed.
can.view(project.activity)
// @ts-expect-error view takes one of project's surfaces, not the project itself.
can.view(project)
// @ts-expect-error AI usage permissions use the typed project capability reference.
can.observe("aiUsage")
// @ts-expect-error AI usage permissions use the typed project capability reference.
can.manage("aiUsage")
// @ts-expect-error observe only accepts registered observability surfaces.
can.observe("events")
// @ts-expect-error manage only accepts connectors or the AI usage management surface.
can.manage("logs")

type _groupId = Expect<Equal<typeof commercial.id, "commercial">>

const membershipPolicy = defineMembershipPolicy("member-admin", {
  grantedTo: [securityAdmins],
  scope: [commercial],
  can: ["invite", "assignGroups"],
})

type _membershipPolicyId = Expect<Equal<typeof membershipPolicy.id, "member-admin">>

defineMembershipPolicy("invalid", {
  // @ts-expect-error grantedTo accepts group definitions, not arbitrary objects
  grantedTo: [{ id: "security-admins" }],
  scope: [commercial],
  can: ["invite"],
})

defineMembershipPolicy("invalid-membership", {
  grantedTo: [securityAdmins],
  scope: [commercial],
  // @ts-expect-error can accepts membership operations, not arbitrary strings
  can: ["delete"],
})

const Note = defineObjectType({
  id: "note",
  name: "Note",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("owner", ref.user(), { query: { searchable: true, filterable: true } }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
  ],
})

const NoteSnapshot = defineDataset("note.snapshot", { schema: [col("id", "string")] })

const noteView = can.view(Note)
type _noteView = Expect<Equal<typeof noteView, ObjectViewGrantBuilder<typeof Note>>>

const conditionalNoteView = noteView.where((note) => note.p.owner.eq(currentUser()))
type _conditionalNoteView = Expect<Equal<typeof conditionalNoteView, ViewGrant<"object">>>

noteView.where((note) => [note.p.status.neq("archived"), note.p.owner.neq(userRef("usr_bot"))])
noteView.where((note) => note.or(note.p.status.eq("open"), note.not(note.p.owner.exists())))
// @ts-expect-error a condition reads the type's own properties.
noteView.where((note) => note.p.amount.gt(100))
// @ts-expect-error currentUser() compares only with a ref.user() property.
noteView.where((note) => note.p.status.eq(currentUser()))
// @ts-expect-error a grant takes one condition; combine them with an array or `and`.
conditionalNoteView.where((note) => note.p.status.eq("open"))
// @ts-expect-error only a grant on one object type takes a condition.
can.view([Note]).where((note) => note.p.status.eq("open"))
// @ts-expect-error selectors cover types a condition cannot name.
can.view(every.object()).where((note) => note.p.status.eq("open"))
// @ts-expect-error a dataset grant takes no condition.
can.view(NoteSnapshot).where((note) => note.p.status.eq("open"))
// @ts-expect-error the member directory takes no condition.
can.view(project.users).where((note) => note.p.status.eq("open"))

defineShare("note", {
  target: Note,
  grants: ({ target }) => {
    // @ts-expect-error a share's grants are its own; they take no condition.
    can.view(target).where((note) => note.p.status.eq("open"))
    return [can.view(target)]
  },
})
