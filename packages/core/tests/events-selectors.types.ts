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

// @ts-expect-error event categories are explicit; the facade is not callable
events(Invoice)

events.object(Invoice).created()
events.object(Invoice).updated()
events.object(Invoice).deleted()
events.object(Invoice).p.amount.created()
events.object(Invoice).p.amount.updated()
events.object(Invoice).p.amount.cleared()
events.object(Invoice).link(Invoice.l.payments).created()
events.object(Invoice).link(Invoice.l.payments).updated()
events.object(Invoice).link(Invoice.l.payments).deleted()
events.object(Invoice).link(Invoice.l.payments).removed()
events.object(Invoice).link(Invoice.l.payments).p.amount.updated()

// @ts-expect-error missing object property
events.object(Invoice).p.missing

// @ts-expect-error missing link property
events.object(Invoice).link(Invoice.l.payments).p.missing

// @ts-expect-error link() expects a link token, not a property token
events.object(Invoice).link(Invoice.p.amount)
