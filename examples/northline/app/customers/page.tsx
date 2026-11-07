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
  formatCoverageHours,
  formatMinutes,
  humanize,
  initials,
  PageHeader,
  QueryState,
  Section,
  StatusBadge,
  StatusIndicator,
} from "../_components/ui"
import { isContractCurrent } from "../_lib/contracts"
import type { QueryRow } from "../_lib/query-types"
import { caseClock, isCaseAtRisk, openServiceCases } from "../_lib/service-cases"

const customersQuery = objects(CustomerAccount)
  .query()
  .orderBy(CustomerAccount.p.name, "asc")
  .limit(100)
const facilitiesQuery = objects(Facility).query().expand(Facility.l.customer).limit(100)
const casesQuery = openServiceCases.expand(ServiceCase.l.customer).limit(100)
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

/** What the list shows of one customer, gathered once for the counts, filters, sort and rows. */
interface CustomerWork {
  readonly facilities: FacilityRow[]
  readonly openCases: CaseRow[]
  readonly atRisk: CaseRow[]
  readonly contracts: ContractRow[]
}

const noWork: CustomerWork = { facilities: [], openCases: [], atRisk: [], contracts: [] }

export default function CustomersPage() {
  const customers = useObjectsQuery(customersQuery)
  const facilities = useObjectsQuery(facilitiesQuery)
  const cases = useObjectsQuery(casesQuery)
  const contracts = useObjectsQuery(contractsQuery)
  const [view, setView] = useState<View>("all")
  const [sort, setSort] = useState<Sort>("exposure")
  const [search, setSearch] = useState("")
  const customerRows = customers.data?.objects ?? []
  const work = useMemo(() => {
    const byCustomer = new Map<string, CustomerWork>()
    const of = (id: string | undefined) => {
      if (!id) return undefined
      let entry = byCustomer.get(id)
      if (!entry) {
        entry = { facilities: [], openCases: [], atRisk: [], contracts: [] }
        byCustomer.set(id, entry)
      }
      return entry
    }
    for (const facility of facilities.data?.objects ?? []) {
      of(facility.links.customer?.primaryId)?.facilities.push(facility)
    }
    for (const serviceCase of cases.data?.objects ?? []) {
      const entry = of(serviceCase.links.customer?.primaryId)
      entry?.openCases.push(serviceCase)
      if (isCaseAtRisk(serviceCase.properties)) entry?.atRisk.push(serviceCase)
    }
    for (const contract of contracts.data?.objects ?? []) {
      of(contract.links.customer?.primaryId)?.contracts.push(contract)
    }
    return byCustomer
  }, [cases.data, contracts.data, facilities.data])
  const workOf = (customer: CustomerRow) => work.get(customer.primaryId) ?? noWork
  const totalAtRisk = [...work.values()].reduce((total, entry) => total + entry.atRisk.length, 0)
  const counts = Object.fromEntries(
    views.map(([id]) => [
      id,
      customerRows.filter((customer) => matchesView(customer, id, workOf(customer))).length,
    ])
  )
  const normalized = search.trim().toLowerCase()
  const rows = customerRows
    .filter((customer) => {
      const customerWork = workOf(customer)
      if (!matchesView(customer, view, customerWork)) return false
      if (!normalized) return true
      return [
        customer.properties.name,
        customer.properties.primaryContactName,
        customer.properties.primaryContactEmail,
        humanize(customer.properties.serviceTier),
        ...customerWork.facilities.flatMap((facility) => [
          facility.properties.name,
          facility.properties.city,
          facility.properties.state,
        ]),
      ].some((value) => value?.toLowerCase().includes(normalized))
    })
    .sort((left, right) => compareCustomers(left, right, sort, workOf(left), workOf(right)))

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

      <Section className="overflow-hidden">
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
                work={workOf(customer)}
              />
            ))}
          </ul>
        </QueryState>
      </Section>
    </div>
  )
}

function CustomerListRow({ customer, work }: { customer: CustomerRow; work: CustomerWork }) {
  const { facilities: customerFacilities, openCases, atRisk: riskCases } = work
  const overdue = riskCases.some(
    (serviceCase) => caseClock(serviceCase.properties).tone === "critical"
  )
  const activeContract = work.contracts.find((contract) =>
    isContractCurrent(contract.properties.status)
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

function matchesView(customer: CustomerRow, view: View, work: CustomerWork): boolean {
  if (view === "all") return true
  if (view === "attention") return work.atRisk.length > 0
  if (view === "multi_site") return work.facilities.length > 1
  return customer.properties.serviceTier === view
}

function compareCustomers(
  left: CustomerRow,
  right: CustomerRow,
  sort: Sort,
  leftWork: CustomerWork,
  rightWork: CustomerWork
): number {
  const byName = () => left.properties.name.localeCompare(right.properties.name)
  if (sort === "name") return byName()
  if (sort === "facilities") {
    return rightWork.facilities.length - leftWork.facilities.length || byName()
  }
  if (sort === "tier") return tierPriority(right) - tierPriority(left) || byName()
  return (
    rightWork.atRisk.length - leftWork.atRisk.length ||
    rightWork.openCases.length - leftWork.openCases.length ||
    byName()
  )
}

function tierPriority(customer: CustomerRow): number {
  return { strategic: 30, priority: 20, standard: 10 }[customer.properties.serviceTier]
}
