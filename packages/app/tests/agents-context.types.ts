import type { AgentContextInput } from "@sixb/core"
import { agentContext } from "../src/agents"

const Invoice = { id: "Invoice" } as const
const invoiceContext = agentContext.object(Invoice, "inv-123")
const viewContext = agentContext.appState("invoice-view", {
  label: "Invoice view",
  description: "Current invoice view state",
  value: { activeTab: "history" },
})

const objectContract: AgentContextInput = invoiceContext
const appStateContract: AgentContextInput = viewContext
void objectContract
void appStateContract

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false
type Expect<TValue extends true> = TValue

type _ObjectTypeAutocomplete = Expect<Equal<typeof invoiceContext.ref.objectTypeId, "Invoice">>
