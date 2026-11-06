import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { useMemo } from "react"
import { WorkOrder } from "../../ontology/work-order"

// What a case waits on someone at Northline to do, by status. The other open statuses wait on the
// field or the customer.
const decisions: Readonly<Record<string, string>> = {
  new: "Acknowledge",
  triage: "Dispatch",
  awaiting_authorization: "Review quote",
  resolved: "Close",
}

/**
 * The decision a case is waiting on, as a button label, or undefined when it waits on no one here.
 * A case in service whose field work is finished waits on someone to verify the unit recovered.
 */
export function caseDecision(
  status: string | undefined,
  fieldWorkDone = false
): string | undefined {
  if (status === "in_service" && fieldWorkDone) return "Verify recovery"
  return decisions[status ?? ""]
}

const completedWork = objects(WorkOrder)
  .query()
  .where((workOrder) => workOrder.p.status.eq("completed"))
  .expand(WorkOrder.l.serviceCase)
  .limit(200)

/** The cases with completed field work, for `caseDecision`. */
export function useCasesWithFieldWorkDone(): ReadonlySet<string> {
  const workOrders = useObjectsQuery(completedWork, { staleTime: 30_000 })
  return useMemo(
    () =>
      new Set(
        (workOrders.data?.objects ?? []).flatMap((workOrder) =>
          workOrder.links.serviceCase ? [workOrder.links.serviceCase.primaryId] : []
        )
      ),
    [workOrders.data]
  )
}
