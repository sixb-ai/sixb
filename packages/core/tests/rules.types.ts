import { defineObjectType, defineRule, link, prop } from "../src"

const Document = defineObjectType({
  id: "document",
  name: "Document",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Transaction = defineObjectType({
  id: "transaction",
  name: "Transaction",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string"),
    prop("amount", "double"),
  ],
  links: [link("document", Document, { cardinality: "one" })],
})

const _validRule = defineRule("transaction.requires-document")
  .on(Transaction)
  .where((tx) => tx.l.document.isMissing())

defineRule("transaction.typed-properties")
  .on(Transaction)
  .where((tx) => {
    tx.p.status.eq("posted")
    tx.p.amount.gt(0)

    // @ts-expect-error unknown properties are not exposed by the subject builder
    tx.p.missing.eq("nope")

    return tx.p.status.notEq("void")
  })

defineRule("transaction.typed-links")
  .on(Transaction)
  .where((tx) => {
    tx.l.document.exists()

    // @ts-expect-error unknown links are not exposed by the subject builder
    tx.l.receipt.exists()

    return tx.l.document.isMissing()
  })

void _validRule
