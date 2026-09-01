import type { AuthSessionAudience, SecurityContext } from "../src"
import { applications, can, defineGroup, defineMembershipPolicy } from "../src"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const securityAdmins = defineGroup("security-admins")
const commercial = defineGroup("commercial")

can.observe("logs")
can.observe("aiUsage")
can.manage("aiUsage")
// @ts-expect-error observe only accepts registered observability surfaces.
can.observe("events")
// @ts-expect-error manage only accepts connectors or the AI usage management surface.
can.manage("logs")

type _groupId = Expect<Equal<typeof commercial.id, "commercial">>

// @ts-expect-error auth audiences are the registered browser applications
const unsupportedAudience: AuthSessionAudience = "backoffice"
void unsupportedAudience

const membershipPolicy = defineMembershipPolicy("member-admin", {
  grantedTo: [securityAdmins],
  scope: [commercial],
  can: ["invite", "assignGroups"],
})

type _membershipPolicyId = Expect<Equal<typeof membershipPolicy.id, "member-admin">>

can.access(applications.atlas)
// @ts-expect-error access grants accept application definitions, not groups
can.access(commercial)

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

const context: SecurityContext = {
  principal: { type: "system", id: "system" },
  projectId: "default",
  correlationId: "corr_1",
}

// @ts-expect-error SecurityContext must not carry userId in issue 173
context.userId
