import type { FleetioHttp } from "../http"
import type { FleetioBulkJob, FleetioBulkJobInput, FleetioId } from "../types"
import { pathId } from "../validation"

const DEFAULT_MAX_RECORDS = 100
const MAX_RECORDS: Readonly<Partial<Record<FleetioBulkJobInput["resource"], number>>> = {
  inventory_journal_entry: 500,
  group: 1000,
}

export interface BulkJobsResource {
  /**
   * `POST /bulk_api_jobs`. Starts a job and returns it as `pending`. A job takes up to 100 records,
   * or 500 for inventory and 1000 for groups. Prefer this over repeated calls above 20 a minute.
   */
  create(input: FleetioBulkJobInput): Promise<FleetioBulkJob>
  /** `GET /bulk_api_jobs/{id}`. Fleetio sends no notice on completion, so poll this. */
  get(id: FleetioId): Promise<FleetioBulkJob>
}

export function bulkJobsResource(http: FleetioHttp): BulkJobsResource {
  return {
    create(input) {
      assertRecordCount(input)
      return http.post("bulk_api_jobs", input)
    },
    get(id) {
      return http.get(`bulk_api_jobs/${pathId(id, "bulk job id")}`)
    },
  }
}

function assertRecordCount(input: FleetioBulkJobInput): void {
  const max = MAX_RECORDS[input.resource] ?? DEFAULT_MAX_RECORDS
  if (input.records.length < 1 || input.records.length > max) {
    throw new Error(`[SixbFleetio] A ${input.resource} bulk job takes 1 to ${max} records.`)
  }
}
