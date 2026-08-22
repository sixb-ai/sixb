import { AgentPanel, agentContext } from "@sixb/app/agents"
import { Button } from "@sixb/ui/components"
import { ChevronRight, MessageSquareText } from "lucide-react"
import { useState } from "react"
import { useLocation } from "react-router-dom"
import { CustomerAccount } from "../../ontology/customer-account"
import { Equipment } from "../../ontology/equipment"
import { ServiceCase } from "../../ontology/service-case"
import { Technician } from "../../ontology/technician"

const pageLabels: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ["/service-cases", "Service cases"],
  ["/dispatch", "Dispatch"],
  ["/quotes", "Quotes"],
  ["/contracts", "Contracts"],
  ["/customers", "Customers"],
  ["/equipment", "Equipment"],
  ["/technicians", "Technicians"],
  ["/review", "Operational review"],
]

export function OperationsAssistant() {
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const pageLabel =
    pageLabels.find(([prefix]) => location.pathname.startsWith(prefix))?.[1] ?? "Today"
  const pageContext = agentContext.appState("northline-current-page", {
    label: pageLabel,
    description: "The current Northline Operations route and query state.",
    value: { path: location.pathname, query: location.search },
  })
  const objectContext = currentObjectContext(location.pathname)
  const context = objectContext ? [pageContext, objectContext] : [pageContext]

  if (location.pathname.startsWith("/agents")) return null

  return (
    <>
      {!open ? (
        <Button
          className="fixed right-5 bottom-5 z-40 h-11 rounded-full px-4 shadow-lg max-sm:right-3 max-sm:bottom-3"
          aria-label="Open Operations Assistant"
          onClick={() => setOpen(true)}
        >
          <MessageSquareText className="size-4" />
          Ask Northline
        </Button>
      ) : null}
      <aside
        aria-label="Northline Operations Assistant"
        aria-hidden={!open}
        inert={!open}
        className={`relative h-svh shrink-0 overflow-hidden bg-background transition-[width,border-color] duration-300 ease-out ${
          open ? "w-full border-l border-border sm:w-[24rem]" : "w-0 border-l border-transparent"
        }`}
      >
        <div className="relative h-full w-screen sm:w-[24rem]">
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 left-2 z-20"
            aria-label="Close Operations Assistant"
            onClick={() => setOpen(false)}
          >
            <ChevronRight className="size-4" />
          </Button>
          <AgentPanel agentId="operations-assistant" context={context} className="h-full" />
        </div>
      </aside>
    </>
  )
}

function currentObjectContext(pathname: string) {
  const serviceCaseId = routeId(pathname, "/service-cases/")
  if (serviceCaseId) return agentContext.object(ServiceCase, serviceCaseId)

  const customerId = routeId(pathname, "/customers/")
  if (customerId) return agentContext.object(CustomerAccount, customerId)

  const equipmentId = routeId(pathname, "/equipment/")
  if (equipmentId) return agentContext.object(Equipment, equipmentId)

  const technicianId = routeId(pathname, "/technicians/")
  if (technicianId) return agentContext.object(Technician, technicianId)

  return undefined
}

function routeId(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined
  const encoded = pathname.slice(prefix.length).split("/")[0]
  if (!encoded) return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}
