import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Input } from "@sixb/ui/components"
import { ArrowUpDown, ChevronRight, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { CustomerAccount } from "../../ontology/customer-account"
import { Facility } from "../../ontology/facility"
import { ServiceCase } from "../../ontology/service-case"
import { ServiceContract } from "../../ontology/service-contract"
import { humanize, QueryState, StatusIndicator } from "../_components/ui"

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
  ["attention", "SLA attention"],
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
type CustomerRow = NonNullable<Awaited<ReturnType<typeof customersQuery.first>>>
type FacilityRow = NonNullable<Awaited<ReturnType<typeof facilitiesQuery.first>>>
type CaseRow = NonNullable<Awaited<ReturnType<typeof casesQuery.first>>>
type ContractRow = NonNullable<Awaited<ReturnType<typeof contractsQuery.first>>>

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
    (serviceCase) =>
      !["closed", "cancelled"].includes(serviceCase.properties.status) &&
      ["at_risk", "breached"].includes(serviceCase.properties.slaStatus)
  ).length
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
    <div className="pb-8">
      <header className="mb-6 flex items-start justify-between gap-6 max-sm:flex-col">
        <div className="min-w-0">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
            Commercial relationships
          </p>
          <h1 className="text-[32px] leading-9 font-semibold tracking-[-0.035em] text-foreground max-sm:text-[28px]">
            Customers
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Accounts ordered by active service exposure across facilities, contracts, and equipment.
          </p>
        </div>
        <div className="shrink-0 text-right max-sm:text-left">
          <strong className="block font-mono text-xl font-semibold">{totalAtRisk}</strong>
          <span className="text-xs text-muted-foreground">SLA risks</span>
        </div>
      </header>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <label className="relative block">
          <span className="sr-only">Search customers</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search customers, contacts, or facilities"
            className="h-12 rounded-lg border-border/90 bg-card pl-11 text-sm shadow-none focus-visible:ring-2"
          />
        </label>

        <label className="relative block">
          <span className="sr-only">Sort customers</span>
          <ArrowUpDown
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as Sort)}
            className="h-12 w-full appearance-none rounded-lg border border-border/90 bg-card pr-10 pl-11 text-sm font-medium text-foreground outline-none transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {sortOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span
            className="pointer-events-none absolute top-1/2 right-4 size-2.5 -translate-y-2/3 rotate-45 border-r border-b border-muted-foreground"
            aria-hidden="true"
          />
        </label>
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-2" aria-label="Customer views">
        {views.map(([value, label]) => {
          const count = customerRows.filter((customer) =>
            matchesView(customer, value, facilitiesFor(customer, facilityRows), caseRows)
          ).length
          const active = view === value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              className={
                active
                  ? "h-9 shrink-0 rounded-md border border-primary bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-sm"
                  : "h-9 shrink-0 rounded-md border border-border/90 bg-card px-3.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/35 hover:text-foreground"
              }
              onClick={() => setView(value)}
            >
              {label} <span className="ml-1.5 font-mono text-[10px] opacity-75">{count}</span>
            </button>
          )
        })}
      </div>

      <section className="mt-3">
        <QueryState
          loading={
            customers.isLoading || facilities.isLoading || cases.isLoading || contracts.isLoading
          }
          error={customers.isError || facilities.isError || cases.isError || contracts.isError}
          empty={rows.length === 0}
          emptyMessage="No customer accounts match this view."
        >
          <div className="grid gap-2.5">
            {rows.map((customer) => (
              <CustomerWorklistRow
                key={customer.primaryId}
                customer={customer}
                facilities={facilitiesFor(customer, facilityRows)}
                cases={casesFor(customer, caseRows)}
                contracts={contractsFor(customer, contractRows)}
              />
            ))}
          </div>
        </QueryState>
      </section>
    </div>
  )
}

function CustomerWorklistRow({
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
  const href = `/customers/${encodeURIComponent(customer.primaryId)}`
  const openCases = customerCases.filter(
    (serviceCase) => !["closed", "cancelled"].includes(serviceCase.properties.status)
  )
  const riskCases = openCases.filter((serviceCase) =>
    ["at_risk", "breached"].includes(serviceCase.properties.slaStatus)
  )
  const activeContract = customerContracts.find((contract) =>
    ["active", "expiring"].includes(contract.properties.status)
  )
  const territories = [
    ...new Set(customerFacilities.map((facility) => humanize(facility.properties.territory))),
  ]

  return (
    <Link
      to={href}
      className="group relative grid grid-cols-[48px_minmax(0,1fr)] items-center gap-x-4 gap-y-4 rounded-xl border border-border/85 bg-card px-4 py-3.5 transition-[border-color,background-color,box-shadow] hover:border-primary/55 hover:bg-primary/[0.025] hover:shadow-[0_1px_2px_rgba(13,32,39,0.04)] focus-visible:border-primary/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring 2xl:grid-cols-[52px_minmax(240px,1.2fr)_minmax(180px,0.72fr)_150px_minmax(190px,0.8fr)_minmax(190px,0.78fr)_18px] 2xl:pr-5"
    >
      <CustomerTile name={customer.properties.name} />

      <div className="min-w-0 self-center">
        <div className="flex flex-wrap items-center gap-2.5">
          <strong className="truncate text-sm font-semibold tracking-[-0.012em] text-foreground group-hover:text-primary">
            {customer.properties.name}
          </strong>
          <TierIndicator tier={customer.properties.serviceTier} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
          <StatusIndicator value={customer.properties.status} />
          <span className="text-[11px] text-muted-foreground">
            {humanize(customer.properties.serviceTier)} service relationship
          </span>
        </div>
      </div>

      <div className="col-start-2 min-w-0 border-t border-border/65 pt-3 2xl:col-start-auto 2xl:border-0 2xl:pt-0">
        <strong className="block text-xs font-semibold text-foreground">
          {customerFacilities.length} {customerFacilities.length === 1 ? "facility" : "facilities"}
        </strong>
        <span className="mt-1.5 block truncate text-[11px] text-muted-foreground">
          {customerFacilities[0]?.properties.name ?? "No facility"}
          {customerFacilities.length > 1 ? ` +${customerFacilities.length - 1} more` : ""}
        </span>
        <span className="mt-1 block truncate text-[10px] text-muted-foreground">
          {territories.join(" · ") || "Territory unavailable"}
        </span>
      </div>

      <div className="col-start-2 2xl:col-start-auto">
        <strong className="block font-mono text-sm font-semibold tracking-[-0.02em]">
          {openCases.length}
        </strong>
        <span className="mt-1 block text-[10px] text-muted-foreground">open service cases</span>
        <span
          className={`mt-1.5 block text-[11px] font-medium ${
            riskCases.length > 0 ? "text-destructive" : "text-[color:var(--success)]"
          }`}
        >
          {riskCases.length > 0
            ? `${riskCases.length} ${riskCases.length === 1 ? "SLA risk" : "SLA risks"}`
            : "SLA on track"}
        </span>
      </div>

      <div className="col-start-2 min-w-0 2xl:col-start-auto">
        {activeContract ? (
          <>
            <strong className="block truncate text-xs font-semibold text-foreground">
              {activeContract.properties.name}
            </strong>
            <span className="mt-1.5 block text-[11px] text-muted-foreground">
              {humanize(activeContract.properties.contractType)} · {coverageLabel(activeContract)}
            </span>
            <span className="mt-1 block text-[10px] text-muted-foreground">
              {duration(activeContract.properties.responseTargetMinutes)} response target
            </span>
          </>
        ) : (
          <>
            <strong className="block text-xs font-medium text-muted-foreground">
              No active contract
            </strong>
            <span className="mt-1.5 block text-[11px] text-muted-foreground">
              Coverage unavailable
            </span>
          </>
        )}
      </div>

      <div className="col-start-2 min-w-0 2xl:col-start-auto">
        <span className="block text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Authorization contact
        </span>
        <strong className="mt-1.5 block truncate text-xs font-semibold text-foreground">
          {customer.properties.primaryContactName ?? "No contact assigned"}
        </strong>
        <span className="mt-1 block truncate text-[11px] text-muted-foreground">
          {customer.properties.primaryContactEmail ?? "—"}
        </span>
      </div>

      <ChevronRight
        className="absolute right-4 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary 2xl:static"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </Link>
  )
}

function CustomerTile({ name }: { name: string }) {
  return (
    <span className="grid size-12 place-items-center rounded-full border border-primary/25 bg-secondary/80 font-mono text-xs font-semibold text-primary">
      {initials(name)}
    </span>
  )
}

function TierIndicator({ tier }: { tier: string }) {
  const tone =
    tier === "strategic"
      ? "text-primary before:bg-primary"
      : tier === "priority"
        ? "text-[color:var(--info)] before:bg-[color:var(--info)]"
        : "text-muted-foreground before:bg-muted-foreground/65"
  return (
    <span
      className={`inline-flex items-center gap-2 text-xs font-medium before:size-1.5 before:rounded-full ${tone}`}
    >
      {humanize(tier)}
    </span>
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

function customerRisk(customer: CustomerRow, cases: readonly CaseRow[]): number {
  return casesFor(customer, cases).filter(
    (serviceCase) =>
      !["closed", "cancelled"].includes(serviceCase.properties.status) &&
      ["at_risk", "breached"].includes(serviceCase.properties.slaStatus)
  ).length
}

function openCaseCount(customer: CustomerRow, cases: readonly CaseRow[]): number {
  return casesFor(customer, cases).filter(
    (serviceCase) => !["closed", "cancelled"].includes(serviceCase.properties.status)
  ).length
}

function tierPriority(customer: CustomerRow): number {
  return { strategic: 30, priority: 20, standard: 10 }[customer.properties.serviceTier]
}

function coverageLabel(contract: ContractRow): string {
  return contract.properties.coverageHours === "24_7" ? "24/7" : "Business hours"
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
}
