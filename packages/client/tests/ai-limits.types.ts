import type {
  CreateAiLimitPolicyData,
  GetAiLimitStatusData,
  GetAiLimitStatusResponse,
  GetAiLimitSubjectOptionsResponse,
  UpdateAiLimitPolicyData,
} from "../src"

const tokenPolicy: CreateAiLimitPolicyData["body"] = {
  subject: { type: "project" },
  limit: { meter: "tokens.total", amount: 1_000_000 },
}

const costPolicy: CreateAiLimitPolicyData["body"] = {
  subject: { type: "serviceAccount", id: "svc_billing" },
  limit: {
    meter: "cost.catalogEstimated",
    amount: { currency: "USD", amountNanos: "25000000000" },
  },
  enabled: true,
}

const update: UpdateAiLimitPolicyData = {
  path: { limitId: "ailim_1" },
  body: { enabled: false },
  url: "/api/ai/limits/{limitId}",
}

declare const status: GetAiLimitStatusResponse
const exactCost: string | undefined = status.items
  .map((item) => item.policy.limit)
  .find((limit) => limit.meter === "cost.catalogEstimated")?.amount.amountNanos
const canManage: boolean = status.capabilities.manage
declare const subjectOptions: GetAiLimitSubjectOptionsResponse
const selectableGroupId: string | undefined = subjectOptions.groups[0]?.id
const selectableUserEmail: string | undefined = subjectOptions.users[0]?.email
const selectableServiceAccountName: string | undefined = subjectOptions.serviceAccounts[0]?.name

void tokenPolicy
void costPolicy
void update
void exactCost
void canManage
void selectableGroupId
void selectableUserEmail
void selectableServiceAccountName

const noOutputCeiling: CreateAiLimitPolicyData["body"] = {
  subject: { type: "project" },
  limit: { meter: "tokens.total", amount: 1_000_000 },
  // @ts-expect-error Per-call maximum output tokens are intentionally not part of limit policies.
  maxOutputTokens: 4_096,
}
void noOutputCeiling

const unsupportedCostCurrency: CreateAiLimitPolicyData["body"] = {
  subject: { type: "project" },
  limit: {
    meter: "cost.catalogEstimated",
    amount: {
      // @ts-expect-error Catalog-estimated limit policies are denominated in USD.
      currency: "EUR",
      amountNanos: "1000000000",
    },
  },
}
void unsupportedCostCurrency

const historicalStatus: GetAiLimitStatusData = {
  url: "/api/ai/limits/status",
  query: {
    // @ts-expect-error Public limit status is restricted to the current period.
    at: "2026-09-10T12:00:00.000Z",
  },
}
void historicalStatus
