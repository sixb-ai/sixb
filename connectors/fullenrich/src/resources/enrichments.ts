import type { FullEnrichHttp } from "../http"
import { job, jobStarted } from "../response"
import type {
  FullEnrichEnrichField,
  FullEnrichEnrichment,
  FullEnrichEnrichmentsResource,
  FullEnrichStartEnrichmentRequest,
} from "../types"
import { assertJobRequest, assertNonEmpty } from "../validation"

export const ENRICH_FIELDS: readonly FullEnrichEnrichField[] = [
  "contact.work_emails",
  "contact.personal_emails",
  "contact.phones",
]

export function enrichmentsResource(http: FullEnrichHttp): FullEnrichEnrichmentsResource {
  return {
    async start(request, options = {}) {
      assertStartRequest(request)
      const body = await http.request({
        operation: "enrichment start",
        method: "POST",
        path: "contact/enrich/bulk",
        query: { silentFail: options.silentFail },
        body: request,
        idempotent: false,
        signal: options.signal,
      })
      return jobStarted("enrichment start", body)
    },
    async get(enrichmentId, options = {}) {
      assertNonEmpty(enrichmentId, "enrichmentId")
      const body = await http.request({
        operation: "enrichment read",
        method: "GET",
        path: `contact/enrich/bulk/${encodeURIComponent(enrichmentId)}`,
        query: { forceResults: options.forceResults },
        idempotent: true,
        signal: options.signal,
        // A job that ran out of credits answers 402 with its partial result.
        resultStatuses: [402],
      })
      return job<FullEnrichEnrichment>("enrichment read", body)
    },
  }
}

function assertStartRequest(request: FullEnrichStartEnrichmentRequest): void {
  assertJobRequest(request, "enrichment")
  for (const [index, contact] of request.data.entries()) {
    const fields = contact.enrich_fields
    if (
      !Array.isArray(fields) ||
      fields.length === 0 ||
      !fields.every((field) => ENRICH_FIELDS.includes(field))
    ) {
      throw new Error(
        `[SixbFullEnrich] data[${index}].enrich_fields must list one or more of ${ENRICH_FIELDS.join(", ")}.`
      )
    }
  }
}
