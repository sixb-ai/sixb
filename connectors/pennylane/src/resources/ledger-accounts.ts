import type { PennylaneHttp } from "../http"
import { listAllCursor } from "../pagination"
import { buildListQuery } from "../query"
import type {
  PennylaneCreateLedgerAccountInput,
  PennylaneLedgerAccount,
  PennylaneLedgerAccountListOptions,
  PennylaneLedgerAccountPage,
  PennylaneUpdateLedgerAccountInput,
} from "../types"
import { assertCursorOptions, pathId } from "../validation"

export interface LedgerAccountsResource {
  /** `GET /ledger_accounts` */
  list(options?: PennylaneLedgerAccountListOptions): Promise<PennylaneLedgerAccountPage>
  listAll(options?: PennylaneLedgerAccountListOptions): AsyncIterable<PennylaneLedgerAccount>
  /** `GET /ledger_accounts/{id}` */
  get(id: number): Promise<PennylaneLedgerAccount>
  /** `POST /ledger_accounts` */
  create(input: PennylaneCreateLedgerAccountInput): Promise<PennylaneLedgerAccount>
  /** `PUT /ledger_accounts/{id}` */
  update(id: number, input: PennylaneUpdateLedgerAccountInput): Promise<PennylaneLedgerAccount>
}

export function createLedgerAccountsResource(http: PennylaneHttp): LedgerAccountsResource {
  const resource: LedgerAccountsResource = {
    list(options) {
      assertCursorOptions(options, 1000)
      return http.get("ledger_accounts", buildListQuery(options))
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(id) {
      return http.get(`ledger_accounts/${pathId(id, "ledger account id")}`)
    },
    create(input) {
      assertLedgerAccountNumber(input)
      return http.post("ledger_accounts", input)
    },
    update(id, input) {
      return http.put(`ledger_accounts/${pathId(id, "ledger account id")}`, input)
    },
  }

  return resource
}

function assertLedgerAccountNumber(input: PennylaneCreateLedgerAccountInput): void {
  if (typeof input?.number !== "string" || !/^\S+$/.test(input.number)) {
    throw new Error(
      "[SixbPennylane] ledger account number must be a non-empty string without whitespace."
    )
  }
}
