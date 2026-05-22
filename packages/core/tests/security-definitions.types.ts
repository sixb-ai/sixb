import type { SecurityContext } from "../src"
import { defineGroup, defineInvitePolicy } from "../src"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const securityAdmins = defineGroup("security-admins")
const commercial = defineGroup("commercial")

type _groupId = Expect<Equal<typeof commercial.id, "commercial">>

const invitePolicy = defineInvitePolicy("default-invites", {
  grantedTo: [securityAdmins],
  canInviteTo: [commercial],
})

type _invitePolicyId = Expect<Equal<typeof invitePolicy.id, "default-invites">>

defineInvitePolicy("invalid", {
  // @ts-expect-error grantedTo accepts group definitions, not arbitrary objects
  grantedTo: [{ id: "security-admins" }],
  canInviteTo: [commercial],
})

const context: SecurityContext = {
  principal: { type: "system", id: "system" },
  projectId: "default",
  correlationId: "corr_1",
}

// @ts-expect-error SecurityContext must not carry userId in issue 173
context.userId
