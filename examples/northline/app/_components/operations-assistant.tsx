import { AgentSurface, agentContext, isAppAgentNavigation, useAgentContext } from "@sixb/app/agents"
import { useLocation, useNavigate } from "react-router-dom"
import { CustomerAccount } from "../../ontology/customer-account"
import { Equipment } from "../../ontology/equipment"
import { ServiceCase } from "../../ontology/service-case"
import { Technician } from "../../ontology/technician"

export function OperationsAssistant() {
  const location = useLocation()
  const navigate = useNavigate()
  const objectContext = currentObjectContext(location.pathname)
  const agentContinuation = isAppAgentNavigation(location.state)
  useAgentContext(objectContext)
  if (
    (location.pathname === "/" && !agentContinuation) ||
    location.pathname.startsWith("/agents") ||
    location.pathname.startsWith("/chat/")
  ) {
    return null
  }

  return (
    <AgentSurface
      agentId="operations-assistant"
      title="Northline Operations Assistant"
      launcherLabel="Ask Northline"
      onModeChange={(mode) => {
        if (mode === "collapsed" && location.pathname === "/" && agentContinuation) {
          navigate(`${location.pathname}${location.search}${location.hash}`, {
            replace: true,
            state: null,
          })
        }
      }}
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
