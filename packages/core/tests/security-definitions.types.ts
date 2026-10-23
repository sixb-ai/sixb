import { agent, can, defineGroup, defineMembershipPolicy, project } from "../src"

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
