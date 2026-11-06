import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { CustomerAccount } from "../../ontology/customer-account"
import { Facility } from "../../ontology/facility"
import { ServiceCase } from "../../ontology/service-case"
import { ServiceContract } from "../../ontology/service-contract"
import { SearchField, SortSelect, ViewPills } from "../_components/list-controls"
import {
  caseClock,
  formatCoverageHours,
  formatMinutes,
  humanize,
  initials,
  isCaseAtRisk,
  PageHeader,
  QueryState,
  StatusBadge,
  StatusIndicator,
} from "../_components/ui"
import type { QueryRow } from "../_lib/query-types"

const customersQuery = objects(CustomerAccount)
  .query()
  .orderBy(CustomerAccount.p.name, "asc")
  .limit(100)
const facilitiesQuery = objects(Facility).query().expand(Facility.l.customer).limit(100)
const casesQuery = objects(ServiceCase).query().expand(ServiceCase.l.customer).limit(100)
const contractsQuery = objects(ServiceContract)
  .query()
  .expand(ServiceContract.l.customer)
  .orderBy(ServiceContract.p.endsOn, "asc")
  .limit(100)

const views = [
  ["all", "All"],
  ["strategic", "Strategic"],
  ["priority", "Priority"],
  ["standard", "Standard"],
  ["attention", "At risk"],
  ["multi_site", "Multiple sites"],
] as const

const sortOptions = [
  ["exposure", "Service exposure"],
  ["name", "Account name"],
  ["facilities", "Facility count"],
  ["tier", "Service tier"],
] as const

type View = (typeof views)[number][0]
type Sort = (typeof sortOptions)[number][0]
type CustomerRow = QueryRow<typeof customersQuery>
type FacilityRow = QueryRow<typeof facilitiesQuery>
type CaseRow = QueryRow<typeof casesQuery>
type ContractRow = QueryRow<typeof contractsQuery>

export default function CustomersPage() {
  const customers = useObjectsQuery(customersQuery)
  const facilities = useObjectsQuery(facilitiesQuery)
  const cases = useObjectsQuery(casesQuery)
  const contracts = useObjectsQuery(contractsQuery)
  const [view, setView] = useState<View>("all")
  const [sort, setSort] = useState<Sort>("exposure")
  const [search, setSearch] = useState("")
  const customerRows = customers.data?.objects ?? []
  const facilityRows = facilities.data?.objects ?? []
  const caseRows = cases.data?.objects ?? []
  const contractRows = contracts.data?.objects ?? []
  const totalAtRisk = caseRows.filter(
    (serviceCase) => isOpenCase(serviceCase) && isAtRisk(serviceCase)
  ).length
  const counts = useMemo(
    () =>
      Object.fromEntries(
        views.map(([id]) => [
          id,
          customerRows.filter((customer) =>
            matchesView(customer, id, facilitiesFor(customer, facilityRows), caseRows)
          ).length,
        ])
      ),
    [caseRows, customerRows, facilityRows]
  )
  const rows = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return customerRows
      .filter((customer) => {
        const customerFacilities = facilitiesFor(customer, facilityRows)
        if (!matchesView(customer, view, customerFacilities, caseRows)) return false
        if (!normalized) return true
        return [
          customer.properties.name,
          customer.properties.primaryContactName,
          customer.properties.primaryContactEmail,
          humanize(customer.properties.serviceTier),
          ...customerFacilities.flatMap((facility) => [
            facility.properties.name,
            facility.properties.city,
            facility.properties.state,
          ]),
        ].some((value) => value?.toLowerCase().includes(normalized))
      })
      .sort((left, right) => compareCustomers(left, right, sort, facilityRows, caseRows))
  }, [caseRows, customerRows, facilityRows, search, sort, view])

  return (
    <div>
      <PageHeader
        title="Customers"
        description={
          <>
            The accounts Northline serves, with their sites, coverage and open work.
            {totalAtRisk > 0 ? (
              <>
                {" "}
                <span className="font-medium text-foreground tabular-nums">{totalAtRisk}</span> open{" "}
                {totalAtRisk === 1 ? "case is" : "cases are"} at risk.
              </>
            ) : null}
          </>
        }
        action={
          <>
            <SearchField
              label="Search customers"
              value={search}
              onChange={setSearch}
              placeholder="Search customers, contacts, sites"
            />
            <SortSelect
              label="Sort customers"
              value={sort}
              options={sortOptions}
              onChange={setSort}
            />
          </>
        }
      >
        <ViewPills
          label="Customer views"
          views={views}
          value={view}
          counts={counts}
          onChange={setView}
        />
      </PageHeader>

      <section className="overflow-hidden rounded-[20px] bg-card shadow-[var(--shadow-card)]">
        <QueryState
          loading={
            customers.isLoading || facilities.isLoading || cases.isLoading || contracts.isLoading
          }
          error={customers.isError || facilities.isError || cases.isError || contracts.isError}
          empty={rows.length === 0}
          emptyMessage={
            search ? "No customers match that search." : "No customer accounts in this view."
          }
        >
          <ul>
            {rows.map((customer) => (
              <CustomerListRow
                key={customer.primaryId}
                customer={customer}
                facilities={facilitiesFor(customer, facilityRows)}
                cases={casesFor(customer, caseRows)}
                contracts={contractsFor(customer, contractRows)}
              />
            ))}
          </ul>
        </QueryState>
      </section>
    </div>
  )
}

function CustomerListRow({
  customer,
  facilities: customerFacilities,
  cases: customerCases,
  contracts: customerContracts,
}: {
  customer: CustomerRow
  facilities: FacilityRow[]
  cases: CaseRow[]
  contracts: ContractRow[]
}) {
  const openCases = customerCases.filter(isOpenCase)
  const riskCases = openCases.filter(isAtRisk)
  const overdue = riskCases.some(
    (serviceCase) => caseClock(serviceCase.properties).tone === "critical"
  )
  const activeContract = customerContracts.find((contract) =>
    ["active", "expiring"].includes(contract.properties.status)
  )
  const summary = [
    humanize(customer.properties.serviceTier),
    `${customerFacilities.length} ${customerFacilities.length === 1 ? "facility" : "facilities"}`,
    customer.properties.primaryContactName,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <li className="border-t border-border/70 first:border-t-0">
      <Link
        to={`/customers/${encodeURIComponent(customer.primaryId)}`}
        className="group grid grid-cols-[2.75rem_minmax(0,1fr)_auto_1rem] items-center gap-4 px-5 py-4 transition-colors hover:bg-black/[0.02] focus-visible:bg-black/[0.03] focus-visible:outline-none max-sm:grid-cols-[2.75rem_minmax(0,1fr)] max-sm:gap-x-3.5 max-sm:gap-y-1.5 sm:px-6 md:grid-cols-[2.75rem_minmax(0,1.3fr)_minmax(0,1fr)_8.5rem_1rem] dark:hover:bg-white/[0.03]"
      >
        {/* On a phone the open work moves under the name, which gets the full width. */}
        <span
          className="flex size-11 items-center justify-center rounded-full bg-[var(--northline-tint)] text-[15px] font-semibold text-primary max-sm:row-span-2 max-sm:self-start"
          aria-hidden="true"
        >
          {initials(customer.properties.name)}
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[16px] font-semibold tracking-[-0.01em] group-hover:text-primary">
              {customer.properties.name}
            </span>
            {customer.properties.status !== "active" ? (
              <StatusBadge value={customer.properties.status} />
            ) : null}
          </span>
          <span className="truncate text-[13.5px] text-muted-foreground">{summary}</span>
        </span>
        <span className="hidden min-w-0 flex-col gap-1 md:flex">
          <span
            className={cn(
              "truncate text-[14.5px] font-medium",
              !activeContract && "text-muted-foreground"
            )}
          >
            {activeContract?.properties.name ?? "No active contract"}
          </span>
          <span className="truncate text-[13px] text-muted-foreground tabular-nums">
            {activeContract
              ? `${formatMinutes(activeContract.properties.responseTargetMinutes)} response · ${formatCoverageHours(
                  activeContract.properties.coverageHours
                )}`
              : "Coverage unavailable"}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1.5 max-sm:col-start-2 max-sm:flex-row max-sm:items-center max-sm:gap-3">
          <span
            className={cn(
              "text-[14.5px] font-medium whitespace-nowrap tabular-nums max-sm:text-[13.5px]",
              openCases.length === 0 && "text-muted-foreground"
            )}
          >
            {openCases.length === 0
              ? "No open cases"
              : `${openCases.length} open ${openCases.length === 1 ? "case" : "cases"}`}
          </span>
          {riskCases.length > 0 ? (
            <StatusIndicator
              value={overdue ? "breached" : "at_risk"}
              label={`${riskCases.length} at risk`}
            />
          ) : openCases.length > 0 ? (
            <StatusIndicator value="on_track" label="On track" />
          ) : null}
        </span>
        <ChevronRight className="size-4 text-muted-foreground/50 group-hover:text-muted-foreground max-sm:hidden" />
      </Link>
    </li>
  )
}

function matchesView(
  customer: CustomerRow,
  view: View,
  customerFacilities: FacilityRow[],
  cases: readonly CaseRow[]
): boolean {
  if (view === "all") return true
  if (view === "attention") return customerRisk(customer, cases) > 0
  if (view === "multi_site") return customerFacilities.length > 1
  return customer.properties.serviceTier === view
}

function compareCustomers(
  left: CustomerRow,
  right: CustomerRow,
  sort: Sort,
  facilities: readonly FacilityRow[],
  cases: readonly CaseRow[]
): number {
  if (sort === "name") return left.properties.name.localeCompare(right.properties.name)
  if (sort === "facilities") {
    const facilityDifference =
      facilitiesFor(right, facilities).length - facilitiesFor(left, facilities).length
    return facilityDifference || left.properties.name.localeCompare(right.properties.name)
  }
  if (sort === "tier") {
    const tierDifference = tierPriority(right) - tierPriority(left)
    return tierDifference || left.properties.name.localeCompare(right.properties.name)
  }
  const riskDifference = customerRisk(right, cases) - customerRisk(left, cases)
  if (riskDifference) return riskDifference
  const openDifference = openCaseCount(right, cases) - openCaseCount(left, cases)
  return openDifference || left.properties.name.localeCompare(right.properties.name)
}

function facilitiesFor(customer: CustomerRow, facilities: readonly FacilityRow[]): FacilityRow[] {
  return facilities.filter((facility) => facility.links.customer?.primaryId === customer.primaryId)
}

function casesFor(customer: CustomerRow, cases: readonly CaseRow[]): CaseRow[] {
  return cases.filter((serviceCase) => serviceCase.links.customer?.primaryId === customer.primaryId)
}

function contractsFor(customer: CustomerRow, contracts: readonly ContractRow[]): ContractRow[] {
  return contracts.filter((contract) => contract.links.customer?.primaryId === customer.primaryId)
}

function isOpenCase(serviceCase: CaseRow): boolean {
  return !["closed", "cancelled"].includes(serviceCase.properties.status)
}

function isAtRisk(serviceCase: CaseRow): boolean {
  return isCaseAtRisk(serviceCase.properties)
}

function customerRisk(customer: CustomerRow, cases: readonly CaseRow[]): number {
  return casesFor(customer, cases).filter(
    (serviceCase) => isOpenCase(serviceCase) && isAtRisk(serviceCase)
  ).length
}

function openCaseCount(customer: CustomerRow, cases: readonly CaseRow[]): number {
  return casesFor(customer, cases).filter(isOpenCase).length
}

function tierPriority(customer: CustomerRow): number {
  return { strategic: 30, priority: 20, standard: 10 }[customer.properties.serviceTier]
}
