import { AgentSurface, agentContext } from "@sixb/app/agents"
import { useEffect, useRef } from "react"
import { useLocation, useMatch, useNavigate } from "react-router-dom"
import { CustomerAccount } from "../../ontology/customer-account"
import { Equipment } from "../../ontology/equipment"
import { ServiceCase } from "../../ontology/service-case"
import { Technician } from "../../ontology/technician"
import { NorthlineWordmark } from "./northline-wordmark"

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
  const navigate = useNavigate()
  const conversationRoute = useMatch("/chat/:id")
  const fullPage = conversationRoute !== null
  const currentLocation = `${location.pathname}${location.search}${location.hash}`
  const lastWorkspaceLocation = useRef("/service-cases")
  useEffect(() => {
    if (!fullPage && location.pathname !== "/" && !location.pathname.startsWith("/agents")) {
      lastWorkspaceLocation.current = currentLocation
    }
  }, [currentLocation, fullPage, location.pathname])
  const objectContext = currentObjectContext(location.pathname)
  const pageLabel =
    pageLabels.find(([prefix]) => location.pathname.startsWith(prefix))?.[1] ?? "Home"
  const pageContext = agentContext.appState("northline-current-page", {
    label: pageLabel,
    description: "The current Northline Operations route and query state.",
    value: { path: location.pathname, query: location.search },
  })
  const context = objectContext ? [pageContext, objectContext] : [pageContext]
  if (location.pathname === "/" || location.pathname.startsWith("/agents")) {
    return null
  }

  return (
    <AgentSurface
      title="Northline Operations Assistant"
      launcherLabel="Ask Northline"
      context={context}
      welcomeContent={<NorthlineWordmark className="h-10" />}
      fullPage={fullPage}
      panelClassName={fullPage ? "max-md:[&_[data-agent-conversation-header]]:pl-12" : undefined}
      threadId={conversationRoute?.params.id}
      onThreadChange={(threadId) => {
        if (fullPage) navigate(threadId ? `/chat/${encodeURIComponent(threadId)}` : "/")
      }}
      onRequestDock={() => navigate(lastWorkspaceLocation.current, { replace: true })}
      onExpandThread={(threadId) => {
        navigate(`/chat/${encodeURIComponent(threadId)}`)
      }}
    />
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
