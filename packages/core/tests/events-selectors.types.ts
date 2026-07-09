import { events } from "../src/events"
import { defineObjectType, link, prop } from "../src/ontology"

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true }), prop("amount", "double")],
  links: [
    link.ref("payments", "Payment", {
      properties: [prop("amount", "double")],
    }),
  ],
})

events(Invoice).created()
events(Invoice).updated()
events(Invoice).deleted()
events(Invoice).p.amount.created()
events(Invoice).p.amount.updated()
events(Invoice).p.amount.cleared()
events(Invoice).link(Invoice.l.payments).created()
events(Invoice).link(Invoice.l.payments).updated()
events(Invoice).link(Invoice.l.payments).deleted()
events(Invoice).link(Invoice.l.payments).removed()
events(Invoice).link(Invoice.l.payments).p.amount.updated()

// @ts-expect-error missing object property
events(Invoice).p.missing

// @ts-expect-error missing link property
events(Invoice).link(Invoice.l.payments).p.missing

// @ts-expect-error link() expects a link token, not a property token
events(Invoice).link(Invoice.p.amount)
