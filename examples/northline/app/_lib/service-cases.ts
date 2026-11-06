// What a case waits on someone at Northline to do, by status. The other open statuses wait on the
// field or the customer.
const decisions: Readonly<Record<string, string>> = {
  new: "Acknowledge",
  triage: "Dispatch",
  awaiting_authorization: "Review quote",
  resolved: "Close",
}

/** The decision a case is waiting on, as a button label, or undefined when it waits on no one here. */
export function caseDecision(status: string | undefined): string | undefined {
  return decisions[status ?? ""]
}
