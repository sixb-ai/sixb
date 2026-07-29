import { pageRows, runIdempotently } from "./client-utils"
import type {
  ContractRow,
  CustomerRow,
  FacilityRow,
  QuoteRow,
  SourceListInput,
  SourcePage,
} from "./contracts"
import { businessStore, initializeDemoSources } from "./source-state"

export interface CreateQuoteInput {
  readonly customerId: string
  readonly facilityId: string
  readonly serviceCaseId: string
  readonly originatingVisitId: string
  readonly scope: string
  readonly reason: string
  readonly amount: number
  readonly validUntil: string
}

export interface BusinessSystemClient {
  listCustomers(input?: SourceListInput): Promise<SourcePage<CustomerRow>>
  listFacilities(input?: SourceListInput): Promise<SourcePage<FacilityRow>>
  listContracts(input?: SourceListInput): Promise<SourcePage<ContractRow>>
  listQuotes(input?: SourceListInput): Promise<SourcePage<QuoteRow>>
  createQuote(input: CreateQuoteInput, idempotencyKey: string): Promise<QuoteRow>
  recordQuoteDecision(
    quoteId: string,
    decision: "approved" | "declined",
    idempotencyKey: string
  ): Promise<QuoteRow>
}

export async function createBusinessSystemClient(): Promise<BusinessSystemClient> {
  await initializeDemoSources()

  return {
    async listCustomers(input) {
      return pageRows((await businessStore.read()).customers, input)
    },
    async listFacilities(input) {
      return pageRows((await businessStore.read()).facilities, input)
    },
    async listContracts(input) {
      return pageRows((await businessStore.read()).contracts, input)
    },
    async listQuotes(input) {
      return pageRows((await businessStore.read()).quotes, input)
    },
    async createQuote(input, idempotencyKey) {
      return businessStore.update((state) =>
        runIdempotently(
          state.idempotency,
          idempotencyKey,
          "createQuote",
          input,
          (id) => state.quotes.find((quote) => quote.quote_id === id),
          () => {
            const sequence =
              884 +
              state.quotes.filter((quote) => Number(quote.quote_number.slice(2)) >= 884).length
            const now = new Date().toISOString()
            const quote: QuoteRow = {
              quote_id: `quote-q-${sequence}`,
              quote_number: `Q-${sequence}`,
              customer_id: input.customerId,
              facility_id: input.facilityId,
              service_case_id: input.serviceCaseId,
              originating_visit_id: input.originatingVisitId,
              scope: input.scope,
              reason: input.reason,
              amount: input.amount,
              currency: "USD",
              status: "sent",
              valid_until: input.validUntil,
              updated_at: now,
            }
            state.quotes.push(quote)
            return quote
          },
          (quote) => quote.quote_id
        )
      )
    },
    async recordQuoteDecision(quoteId, decision, idempotencyKey) {
      return businessStore.update((state) =>
        runIdempotently(
          state.idempotency,
          idempotencyKey,
          "recordQuoteDecision",
          { quoteId, decision },
          (id) => state.quotes.find((quote) => quote.quote_id === id),
          () => {
            const quote = state.quotes.find((item) => item.quote_id === quoteId)
            if (!quote) throw new Error(`[NorthlineSource] Quote '${quoteId}' was not found.`)
            quote.status = decision
            quote.decision_at = new Date().toISOString()
            quote.updated_at = quote.decision_at
            return quote
          },
          (quote) => quote.quote_id
        )
      )
    },
  }
}
