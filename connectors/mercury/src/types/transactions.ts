import type { MercuryCategory, MercuryMerchantCategory } from "./categories"
import type {
  MercuryAddress,
  MercuryAddressData,
  MercuryCurrencyCode,
  MercuryCursorOptions,
  MercuryOrder,
  MercuryPageCursors,
  MercuryTimestamp,
} from "./common"

export type MercuryTransactionStatus =
  | "pending"
  | "sent"
  | "cancelled"
  | "failed"
  | "reversed"
  | "blocked"

export type MercuryTransactionKind =
  | "externalTransfer"
  | "internalTransfer"
  | "outgoingPayment"
  | "creditCardCredit"
  | "creditCardTransaction"
  | "debitCardCredit"
  | "debitCardTransaction"
  | "cardInternationalTransactionFee"
  | "cardInternationalTransactionFeeRebate"
  | "cardInternationalTransactionFeeReversal"
  | "cardInternationalTransactionFeeRebateReversal"
  | "incomingDomesticWire"
  | "checkDeposit"
  | "incomingInternationalWire"
  | "treasuryTransfer"
  | "currencyCloudReturn"
  | "wireFee"
  | "personalBankingSubscriptionFee"
  | "billingEngineSubscriptionFee"
  | "expenseReimbursement"
  | "exogenousWireDrawdown"
  | "interestPayment"
  | "other"

export type MercuryTransactionAttachmentType = "checkImage" | "receipt" | "other"

export interface MercuryTransactionAttachment {
  readonly fileName: string
  readonly url: string
  readonly attachmentType: MercuryTransactionAttachmentType
}

export type MercuryTransactionRelationKind =
  | "ProvisionalCreditReversalToMerchantRefund"
  | "MerchantRefundToProvisionalCreditReversal"
  | "MerchantRefundToFraudulentCharge"
  | "FraudulentChargeToMerchantRefund"
  | "PaymentRefundToFailedPayment"
  | "FailedPaymentToPaymentRefund"
  | "GiftCompensationToOriginalTransaction"
  | "FeePaymentToOriginalTransaction"
  | "OriginalTransactionToFeePayment"
  | "FeePaymentToFeeRebate"
  | "FeeRebateToFeePayment"
  | "FeePaymentToFeeReversal"
  | "FeeReversalToFeePayment"
  | "FeeRebateToFeeRebateReversal"
  | "FeeRebateReversalToFeeRebate"
  | "TreasurySplitLiquidation"
  | "ProvisionalCreditToOriginalCharge"
  | "OriginalChargeToProvisionalCredit"
  | "FeeAtmReimbursementToAtmTransaction"
  | "AtmTransactionToFeeAtmReimbursement"
  | "AtmTransactionToAtmReimbursementReversal"
  | "AtmReimbursementReversalToAtmTransaction"
  | "ReturnToOriginalTransaction"
  | "OriginalTransactionToReturn"
  | "ProvisionalCreditToReversal"
  | "ReversalToProvisionalCredit"
  | "MerchantRefundToOriginalCharge"
  | "OriginalChargeToMerchantRefund"

export interface MercuryRelatedTransaction {
  readonly id: string
  readonly accountId: string
  readonly relationKind: MercuryTransactionRelationKind
  readonly amount: number
}

/**
 * A GL code allocation from a connected accounting integration (QuickBooks, Xero, NetSuite).
 * Allocation amounts sum to the transaction total once it is fully categorized.
 */
export interface MercuryGlAllocation {
  readonly glCodeName: string
  readonly amount: number
  readonly description?: string | null
}

/** Merchant details, present on card transactions only. */
export interface MercuryMerchantData {
  readonly id?: string | null
  /** 4-digit merchant category code (MCC). */
  readonly categoryCode?: string | null
  readonly category?: MercuryMerchantCategory | null
  /** ISO 4217 code of the merchant's currency, when it differs from the account currency. */
  readonly currency?: MercuryCurrencyCode | null
  /**
   * Amount in the merchant currency's smallest unit — cents for USD and EUR, whole yen for JPY,
   * thousandths for BHD, KWD, and OMR. Negative for debits. Scale it using `currency`; unlike
   * every other amount on a transaction this one is a minor-unit integer, not a decimal.
   */
  readonly amount?: number | null
}

export interface MercuryCurrencyExchangeInfo {
  readonly convertedFromCurrency: MercuryCurrencyCode
  readonly convertedToCurrency: MercuryCurrencyCode
  readonly convertedFromAmount: number
  readonly convertedToAmount: number
  readonly feeAmount: number
  readonly feePercentage: number
  /** `convertedFromAmount * exchangeRate = convertedToAmount`. */
  readonly exchangeRate: number
  readonly feeTransactionId?: string | null
}

export type MercuryElectronicAccountType =
  | "businessChecking"
  | "businessSavings"
  | "personalChecking"
  | "personalSavings"

export interface MercuryElectronicRoutingInfo {
  readonly accountNumber: string
  readonly routingNumber: string
  readonly electronicAccountType: MercuryElectronicAccountType
  readonly bankName?: string | null
  readonly address?: MercuryAddress | null
}

export interface MercuryDomesticWireRoutingInfo {
  readonly accountNumber: string
  readonly routingNumber: string
  readonly bankName?: string | null
  readonly address?: MercuryAddress | null
}

export interface MercurySwiftCodeData {
  readonly bankName: string
  readonly bankCityState: string
  readonly bankCountry: string
}

export interface MercuryInternationalWireCorrespondentInfo {
  readonly bankName?: string | null
  readonly routingNumber?: string | null
  readonly swiftCode?: string | null
}

export type MercurySwiftBankAccountType = "checking" | "savings"

export type MercuryPakistaniLegalIdType = "CNIC" | "SNIC" | "Passport" | "NTN"

/** Per-country wire identifiers. Exactly one member is populated for a given wire. */
export interface MercuryInternationalWireCountrySpecificData {
  readonly australia?: { readonly bsbCode: string } | null
  readonly brazil?: { readonly legalId: string } | null
  readonly canada?: { readonly bankCode: string; readonly transitNumber: string } | null
  readonly chile?: { readonly legalId: string } | null
  readonly colombia?: { readonly legalId: string } | null
  readonly dominicanRepublic?: {
    readonly accountType: MercurySwiftBankAccountType
    readonly legalId: string
  } | null
  readonly honduras?: {
    readonly accountType: MercurySwiftBankAccountType
    readonly legalId: string
  } | null
  readonly india?: { readonly ifscCode: string } | null
  readonly kazakhstan?: { readonly legalId: string } | null
  readonly pakistan?: {
    readonly legalIdType: MercuryPakistaniLegalIdType
    readonly legalId: string
  } | null
  readonly paraguay?: { readonly legalId: string } | null
  readonly philippines?: { readonly routingNumber: string } | null
  readonly russia?: { readonly inn: string } | null
  readonly southAfrica?: { readonly branchCode: string } | null
}

export interface MercuryInternationalWireRoutingInfo {
  readonly iban: string
  readonly swiftCode: string
  readonly countrySpecific: MercuryInternationalWireCountrySpecificData
  readonly bankDetails?: MercurySwiftCodeData | null
  readonly correspondentInfo?: MercuryInternationalWireCorrespondentInfo | null
  readonly address?: MercuryAddress | null
  readonly emailAddress?: string | null
  readonly phoneNumber?: string | null
}

/** Method-specific routing details. Only the member matching the payment rail is populated. */
export interface MercuryTransactionMethodData {
  readonly address?: MercuryAddressData | null
  readonly domesticWireRoutingInfo?: MercuryDomesticWireRoutingInfo | null
  readonly electronicRoutingInfo?: MercuryElectronicRoutingInfo | null
  readonly internationalWireRoutingInfo?: MercuryInternationalWireRoutingInfo | null
  readonly debitCardInfo?: { readonly id: string } | null
  readonly creditCardInfo?: {
    readonly id: string
    readonly paymentMethod: string
    readonly email?: string | null
  } | null
}

export interface MercuryTransaction {
  readonly id: string
  /** The Mercury account that owns this transaction. */
  readonly accountId: string
  /** Signed decimal amount in the account currency. Negative for debits. */
  readonly amount: number
  readonly status: MercuryTransactionStatus
  readonly kind: MercuryTransactionKind
  readonly counterpartyId: string
  readonly counterpartyName: string
  readonly counterpartyNickname?: string | null
  readonly createdAt: MercuryTimestamp
  readonly estimatedDeliveryDate: MercuryTimestamp
  readonly postedAt?: MercuryTimestamp | null
  readonly failedAt?: MercuryTimestamp | null
  readonly reasonForFailure?: string | null
  readonly bankDescription?: string | null
  readonly externalMemo?: string | null
  readonly note?: string | null
  /** The organization's custom expense category, when one is assigned. */
  readonly categoryData?: MercuryCategory | null
  /** Mercury's merchant-type classification. Read-only. */
  readonly mercuryCategory?: MercuryMerchantCategory | null
  readonly merchant?: MercuryMerchantData | null
  readonly glAllocations: readonly MercuryGlAllocation[]
  /**
   * @deprecated Use `glAllocations`. This field does not reflect GL codes assigned by Mercury
   * auto-categorization rules and is retained upstream for backwards compatibility.
   */
  readonly generalLedgerCodeName?: string | null
  readonly attachments: readonly MercuryTransactionAttachment[]
  readonly relatedTransactions: readonly MercuryRelatedTransaction[]
  readonly compliantWithReceiptPolicy: boolean
  readonly hasGeneratedReceipt: boolean
  readonly details?: MercuryTransactionMethodData | null
  readonly currencyExchangeInfo?: MercuryCurrencyExchangeInfo | null
  /** Present for check deposits and mailed checks. */
  readonly checkNumber?: string | null
  /** Present for rails that expose tracking, such as RTP, ACH, and wires. */
  readonly trackingNumber?: string | null
  readonly feeId?: string | null
  readonly creditAccountPeriodId?: string | null
  /** Set when the transaction originated from a send-money request. */
  readonly requestId?: string | null
  readonly dashboardLink: string
}

export interface MercuryTransactionsResponse {
  readonly transactions: readonly MercuryTransaction[]
  readonly page: MercuryPageCursors
}

/** `GET /account/{accountId}/transactions` is offset-paginated and reports a total instead. */
export interface MercuryAccountTransactionsResponse {
  readonly transactions: readonly MercuryTransaction[]
  readonly total: number
}

export interface MercuryTransactionListOptions extends MercuryCursorOptions {
  readonly status?: readonly MercuryTransactionStatus[]
  /** Free-text search over transaction descriptions. */
  readonly search?: string
  /** Earliest `createdAt`, as `YYYY-MM-DD` or ISO 8601. Defaults to your first transaction. */
  readonly start?: string
  /** Latest `createdAt`, as `YYYY-MM-DD` or ISO 8601. Defaults to today. */
  readonly end?: string
  /** Earliest `postedAt`, as `YYYY-MM-DD` or ISO 8601. */
  readonly postedStart?: string
  /** Latest `postedAt`, as `YYYY-MM-DD` or ISO 8601. */
  readonly postedEnd?: string
  readonly accountId?: readonly string[]
  readonly cardId?: readonly string[]
  /** Filter by merchant type, shown as "Merchant Type" in the dashboard. */
  readonly mercuryCategory?: MercuryMerchantCategory
  /** Filter by custom expense category id. */
  readonly categoryId?: string
  /** Start the page at this id (inclusive). Excludes `start_after` and `end_before`. */
  readonly start_at?: string
}

export interface MercuryAccountTransactionListOptions {
  /** Results per page, 1 to 1000. Defaults to 1000 upstream. */
  readonly limit?: number
  readonly order?: MercuryOrder
  /** Rows to skip. This endpoint paginates by offset, not by cursor. */
  readonly offset?: number
  /** Earliest transaction date. Defaults to 30 days ago on this endpoint. */
  readonly start?: string
  readonly end?: string
  readonly search?: string
  readonly status?: MercuryTransactionStatus
  /** Filter by the request id returned when the payment was requested. */
  readonly requestId?: string
  readonly mercuryCategory?: MercuryMerchantCategory
  readonly categoryId?: string
}

/**
 * Transaction metadata update. Omit a field to leave it unchanged, or send `null` to clear it.
 *
 * Mercury's schema marks both fields required while documenting omit-to-keep semantics; the
 * connector follows the documented behavior and sends only the fields you pass.
 */
export interface MercuryUpdateTransactionInput {
  readonly note?: string | null
  readonly categoryId?: string | null
}
