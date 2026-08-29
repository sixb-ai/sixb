import {
  can,
  defineAction,
  defineObjectType,
  defineShare,
  link,
  type ObjectRef,
  objectRef,
  prop,
  type Sixb,
} from "../src"

const Product = defineObjectType({
  id: "product",
  name: "Product",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const Item = defineObjectType({
  id: "item",
  name: "Item",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("product", Product)],
})
const Proposal = defineObjectType({
  id: "proposal",
  name: "Proposal",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("items", Item)],
})
const Other = defineObjectType({
  id: "other",
  name: "Other",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("otherProduct", Product)],
})

const approve = defineAction("approve")
  .on(Proposal)
  .params({})
  .writeback(async () => {})
const globalAction = defineAction("global")
  .params({})
  .writeback(async () => {})

export const ProposalShare = defineShare("proposal", {
  target: Proposal,
  grants: ({ target }) => [
    can.view(target).withLinks([Proposal.l.items.withLinks([Item.l.product])]),
    can.apply(approve).on(target),
  ],
})

const proposalRef: ObjectRef<"proposal"> = objectRef(Proposal, "proposal-1")
void proposalRef

// @ts-expect-error objectRef preserves the concrete object type id
const wrongRef: ObjectRef<"other"> = objectRef(Proposal, "proposal-1")
void wrongRef

defineShare("wrong-link-source", {
  target: Proposal,
  grants: ({ target }) => [
    // @ts-expect-error outer links must start on the Share target type
    can.view(target).withLinks([Other.l.otherProduct]),
  ],
})

defineShare("wrong-action-target", {
  target: Other,
  grants: ({ target }) => [
    can.view(target),
    // @ts-expect-error shared Actions are exact-target typed
    can.apply(approve).on(target),
  ],
})

// @ts-expect-error global Actions have no contextual `.on(target)` builder
can.apply(globalAction).on({})

// @ts-expect-error arrays remain ordinary role grants, not contextual Action builders
can.apply([approve]).on({})

// @ts-expect-error ordinary role view grants do not expose Share link selection
can.view(Proposal).withLinks()

declare const sixb: Sixb

void sixb.shares.issue(ProposalShare, {
  // @ts-expect-error issuing a typed Share requires an exact ref to its target type
  target: objectRef(Other, "other-1"),
  destinationPath: "/proposals/proposal-1",
  expiresAt: new Date(),
})

// @ts-expect-error filtering a typed Share requires an exact ref to its target type
void sixb.shares.list(ProposalShare, { target: objectRef(Other, "other-1") })
