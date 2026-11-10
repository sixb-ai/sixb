import type { QuickBooksLinkedTransaction } from "./types/transactions"
import type {
  QuickBooksAllocationLine,
  QuickBooksBillPaymentCreate,
  QuickBooksDepositWriteLine,
  QuickBooksExpenseWriteLine,
  QuickBooksInvoiceLine,
  QuickBooksJournalEntryWriteLine,
  QuickBooksTimeActivityCreate,
  QuickBooksTimeActivityUpdate,
} from "./types/writes"
import { nonEmpty } from "./validation"
import { finiteAmount, nonEmptyLines } from "./write"

export function salesLines(lines: readonly QuickBooksInvoiceLine[]) {
  nonEmptyLines(lines)
  for (const line of lines) {
    if (line.DetailType === "SalesItemLineDetail") {
      nonEmpty(line.SalesItemLineDetail?.ItemRef?.value, "Line.SalesItemLineDetail.ItemRef.value")
      if (!Number.isFinite(line.Amount))
        throw new Error("[SixbQuickBooks] Sales item Line.Amount must be finite.")
    }
  }
}

const ESTIMATE_STATUSES = new Set(["Pending", "Accepted", "Closed", "Rejected"])

export function estimateStatus(value: unknown) {
  if (value !== undefined && (typeof value !== "string" || !ESTIMATE_STATUSES.has(value)))
    throw new Error("[SixbQuickBooks] TxnStatus must be Pending, Accepted, Closed, or Rejected.")
}

export function expenseLines(lines: readonly QuickBooksExpenseWriteLine[]) {
  nonEmptyLines(lines)
  for (const line of lines) {
    if (line.DetailType !== "DescriptionOnly" && !Number.isFinite(line.Amount))
      throw new Error("[SixbQuickBooks] Line.Amount must be finite.")
    if (line.DetailType === "AccountBasedExpenseLineDetail")
      nonEmpty(line.AccountBasedExpenseLineDetail?.AccountRef?.value, "Line.AccountRef.value")
    else if (line.DetailType === "ItemBasedExpenseLineDetail")
      nonEmpty(line.ItemBasedExpenseLineDetail?.ItemRef?.value, "Line.ItemRef.value")
  }
}

export function linkedTransactions(links: readonly QuickBooksLinkedTransaction[] | undefined) {
  if (links === undefined) return
  if (!Array.isArray(links)) throw new Error("[SixbQuickBooks] LinkedTxn must be an array.")
  for (const link of links) {
    nonEmpty(link?.TxnId, "LinkedTxn.TxnId")
    nonEmpty(link.TxnType, "LinkedTxn.TxnType")
  }
}

export function purchasePayment(input: { PaymentType?: unknown; AccountRef?: { value?: string } }) {
  if (
    input.PaymentType !== undefined &&
    input.PaymentType !== "Cash" &&
    input.PaymentType !== "Check" &&
    input.PaymentType !== "CreditCard"
  )
    throw new Error("[SixbQuickBooks] PaymentType must be Cash, Check, or CreditCard.")
  if (input.AccountRef !== undefined) nonEmpty(input.AccountRef.value, "AccountRef.value")
}

export function allocations(lines: readonly QuickBooksAllocationLine[]) {
  if (!Array.isArray(lines)) throw new Error("[SixbQuickBooks] Line must be an array.")
  for (const line of lines) {
    finiteAmount(line.Amount, "Line.Amount")
    if (!Array.isArray(line.LinkedTxn) || !line.LinkedTxn.length)
      throw new Error("[SixbQuickBooks] Allocation lines require LinkedTxn.")
    linkedTransactions(line.LinkedTxn)
  }
}

/** A sub-class or sub-department needs its parent. */
export function parentRef(sub: boolean | undefined, parent: { value: string } | undefined) {
  if (sub === true) nonEmpty(parent?.value, "ParentRef.value")
}

export function billPayment(input: QuickBooksBillPaymentCreate) {
  nonEmpty(input.VendorRef?.value, "VendorRef.value")
  finiteAmount(input.TotalAmt)
  allocations(input.Line)
  if (input.PayType === "Check" && input.CreditCardPayment === undefined)
    nonEmpty(input.CheckPayment?.BankAccountRef?.value, "CheckPayment.BankAccountRef.value")
  else if (input.PayType === "CreditCard" && input.CheckPayment === undefined)
    nonEmpty(input.CreditCardPayment?.CCAccountRef?.value, "CreditCardPayment.CCAccountRef.value")
  else
    throw new Error(
      "[SixbQuickBooks] PayType must match exactly one CheckPayment or CreditCardPayment."
    )
}

export function timeActivity(
  input: QuickBooksTimeActivityCreate | QuickBooksTimeActivityUpdate,
  create: boolean
) {
  if (create || input.NameOf !== undefined) {
    if (input.NameOf === "Employee" && input.VendorRef === undefined)
      nonEmpty(input.EmployeeRef?.value, "EmployeeRef.value")
    else if (input.NameOf === "Vendor" && input.EmployeeRef === undefined)
      nonEmpty(input.VendorRef?.value, "VendorRef.value")
    else
      throw new Error(
        "[SixbQuickBooks] NameOf must be Employee with EmployeeRef or Vendor with VendorRef."
      )
  } else if (input.EmployeeRef !== undefined || input.VendorRef !== undefined)
    throw new Error("[SixbQuickBooks] Changing EmployeeRef or VendorRef requires NameOf.")
  for (const field of ["Hours", "Minutes"] as const) {
    const amount = input[field]
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0))
      throw new Error(`[SixbQuickBooks] ${field} must be a nonnegative integer.`)
  }
  if (create && input.Hours === undefined && input.Minutes === undefined) {
    nonEmpty(input.StartTime, "StartTime (or Hours/Minutes)")
    nonEmpty(input.EndTime, "EndTime")
  }
  const status: unknown = input.BillableStatus
  if (
    status !== undefined &&
    !["Billable", "NotBillable", "HasBeenBilled"].includes(status as string)
  )
    throw new Error(
      "[SixbQuickBooks] BillableStatus must be Billable, NotBillable, or HasBeenBilled."
    )
}

export function depositLines(lines: readonly QuickBooksDepositWriteLine[]) {
  nonEmptyLines(lines)
  for (const line of lines) {
    // Deposit lines can be negative (for example, a fee netted from the deposit).
    if (!Number.isFinite(line.Amount))
      throw new Error("[SixbQuickBooks] Deposit Line.Amount must be finite.")
    const links = "LinkedTxn" in line ? line.LinkedTxn : undefined
    if ("DetailType" in line && line.DetailType === "DepositLineDetail")
      nonEmpty(line.DepositLineDetail?.AccountRef?.value, "Line.DepositLineDetail.AccountRef.value")
    else if (Array.isArray(links) && links.length) linkedTransactions(links)
    else
      throw new Error(
        "[SixbQuickBooks] Deposit lines need DepositLineDetail with AccountRef or LinkedTxn."
      )
  }
}

export function journalLines(lines: readonly QuickBooksJournalEntryWriteLine[]) {
  nonEmptyLines(lines)
  for (const line of lines) {
    finiteAmount(line.Amount, "Line.Amount")
    if (line.DetailType !== "JournalEntryLineDetail")
      throw new Error("[SixbQuickBooks] Journal entry lines need JournalEntryLineDetail.")
    const detail = line.JournalEntryLineDetail
    if (detail?.PostingType !== "Debit" && detail?.PostingType !== "Credit")
      throw new Error("[SixbQuickBooks] PostingType must be Debit or Credit.")
    nonEmpty(detail.AccountRef?.value, "Line.JournalEntryLineDetail.AccountRef.value")
  }
}
