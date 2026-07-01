import type { SecurityContext } from "../src"
import { defineGroup, defineMembershipPolicy } from "../src"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const securityAdmins = defineGroup("security-admins")
const commercial = defineGroup("commercial")

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

const context: SecurityContext = {
  principal: { type: "system", id: "system" },
  projectId: "default",
  correlationId: "corr_1",
}

// @ts-expect-error SecurityContext must not carry userId in issue 173
context.userId
