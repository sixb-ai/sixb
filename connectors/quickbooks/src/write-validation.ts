import type {
  QuickBooksAllocationLine,
  QuickBooksBillPaymentCreate,
  QuickBooksExpenseWriteLine,
  QuickBooksInvoiceLine,
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

export function allocations(lines: readonly QuickBooksAllocationLine[]) {
  if (!Array.isArray(lines)) throw new Error("[SixbQuickBooks] Line must be an array.")
  for (const line of lines) {
    finiteAmount(line.Amount, "Line.Amount")
    if (!Array.isArray(line.LinkedTxn) || !line.LinkedTxn.length)
      throw new Error("[SixbQuickBooks] Allocation lines require LinkedTxn.")
    for (const link of line.LinkedTxn) {
      nonEmpty(link.TxnId, "LinkedTxn.TxnId")
      nonEmpty(link.TxnType, "LinkedTxn.TxnType")
    }
  }
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
