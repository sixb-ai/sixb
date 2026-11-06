import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { ServiceContract } from "../../ontology/service-contract"
import { SearchField, SortSelect, ViewPills } from "../_components/list-controls"
import { humanize, PageHeader, QueryState, StatusBadge } from "../_components/ui"

const contractsQuery = objects(ServiceContract)
  .query()
  .expand(ServiceContract.l.customer)
  .expand(ServiceContract.l.coveredFacilities, { limit: 10 })
  .orderBy(ServiceContract.p.endsOn, "asc")
  .limit(100)

const views = [
  ["all", "All"],
  ["active", "Active"],
  ["full_service", "Full service"],
  ["priority_care", "PriorityCare"],
  ["preventive", "Preventive"],
  ["renewing", "Renewing soon"],
] as const

const sortOptions = [
  ["renewal", "Renewal risk"],
  ["response", "Response target"],
  ["customer", "Customer"],
  ["number", "Contract number"],
] as const

const contractTypes: Record<string, string> = {
  full_service: "Full service",
  priority_care: "PriorityCare",
  preventive: "Preventive",
}

// One template for the header and every row, so the columns line up like a table.
const columns =
  "grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.85fr)_minmax(0,1.1fr)_6rem_1rem]"

type View = (typeof views)[number][0]
type Sort = (typeof sortOptions)[number][0]
type ContractRow = NonNullable<Awaited<ReturnType<typeof contractsQuery.first>>>

export default function ContractsPage() {
  const contracts = useObjectsQuery(contractsQuery)
  const [view, setView] = useState<View>("all")
  const [sort, setSort] = useState<Sort>("renewal")
  const [search, setSearch] = useState("")
  const allRows = contracts.data?.objects ?? []
  const renewalRisks = allRows.filter(needsRenewalAttention).length
  const counts = useMemo(
    () =>
      Object.fromEntries(
        views.map(([id]) => [id, allRows.filter((contract) => matchesView(contract, id)).length])
      ),
    [allRows]
  )
  const rows = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return allRows
      .filter((contract) => {
        if (!matchesView(contract, view)) return false
        if (!normalized) return true
        return [
          contract.properties.number,
          contract.properties.name,
          humanize(contract.properties.contractType),
          contractTypes[contract.properties.contractType],
          contract.links.customer?.properties.name,
          ...contract.links.coveredFacilities.map((facility) => facility.properties.name),
        ].some((value) => value?.toLowerCase().includes(normalized))
      })
      .sort((left, right) => compareContracts(left, right, sort))
  }, [allRows, search, sort, view])

  return (
    <div>
      <PageHeader
        title="Contracts"
        description={
          <>
            Response commitments and coverage for every serviced facility.
            {renewalRisks > 0 ? (
              <>
                {" "}
                <span className="font-medium text-foreground tabular-nums">{renewalRisks}</span>{" "}
                {renewalRisks === 1 ? "needs" : "need"} renewal attention.
              </>
            ) : null}
          </>
        }
        action={
          <>
            <SearchField
              label="Search contracts"
              value={search}
              onChange={setSearch}
              placeholder="Search contracts, customers, sites"
            />
            <SortSelect
              label="Sort contracts"
              value={sort}
              options={sortOptions}
              onChange={setSort}
            />
          </>
        }
      >
        <ViewPills
          label="Contract views"
          views={views}
          value={view}
          counts={counts}
          onChange={setView}
        />
      </PageHeader>

      <section className="overflow-hidden rounded-[20px] bg-card shadow-[var(--shadow-card)]">
        <QueryState
          loading={contracts.isLoading}
          error={contracts.isError}
          empty={rows.length === 0}
          emptyMessage={
            search ? "No contracts match that search." : "No service contracts in this view."
          }
        >
          {/* On narrow screens the list scrolls sideways inside the card instead of squeezing. */}
          <div className="overflow-x-auto">
            <div className="min-w-[56rem]">
              <div
                className={cn(
                  "grid items-center gap-4 px-6 pt-4 pb-2.5 text-[12.5px] font-medium text-muted-foreground",
                  columns
                )}
              >
                <span>Customer and contract</span>
                <span>Type</span>
                <span>Coverage hours</span>
                <span>Response</span>
                <span>Term</span>
                <span>Status</span>
                <span />
              </div>
              <ul>
                {rows.map((contract) => (
                  <ContractListRow key={contract.primaryId} contract={contract} />
                ))}
              </ul>
            </div>
          </div>
        </QueryState>
      </section>
    </div>
  )
}

function ContractListRow({ contract }: { contract: ContractRow }) {
  const { properties } = contract
  const customer = contract.links.customer
  const href = customer ? `/customers/${encodeURIComponent(customer.primaryId)}` : undefined
  const rowClass = cn("grid items-center gap-4 px-6 py-3.5", columns)
  const content = (
    <>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-[15px] font-semibold tracking-[-0.01em]",
            customer ? "group-hover:text-primary" : "text-muted-foreground"
          )}
        >
          {customer?.properties.name ?? "Customer unavailable"}
        </span>
        <span className="truncate text-[13px] text-muted-foreground">
          {properties.name} · <span className="tabular-nums">{properties.number}</span>
        </span>
      </span>
      <Cell
        primary={contractTypes[properties.contractType] ?? properties.contractType}
        secondary={
          properties.majorComponentsExcluded ? "Major parts excluded" : "Major parts included"
        }
      />
      <Cell
        primary={properties.coverageHours === "24_7" ? "24/7" : "Business hours"}
        secondary={properties.includedLabor ? "Labor included" : "Labor excluded"}
      />
      <Cell
        primary={duration(properties.responseTargetMinutes)}
        secondary={`${duration(properties.resolutionTargetMinutes)} to resolve`}
      />
      <Cell
        primary={`${monthYear(properties.startsOn)} – ${monthYear(properties.endsOn)}`}
        secondary={renewalLabel(properties.endsOn)}
        secondaryClassName={renewalTone(contract)}
      />
      <span>
        <StatusBadge value={properties.status} />
      </span>
      <ChevronRight
        className={cn(
          "size-4",
          href ? "text-muted-foreground/50 group-hover:text-muted-foreground" : "opacity-0"
        )}
        aria-hidden="true"
      />
    </>
  )

  return (
    <li className="border-t border-border/70">
      {href ? (
        <Link
          to={href}
          className={cn(
            rowClass,
            "group transition-colors hover:bg-black/[0.02] focus-visible:bg-black/[0.03] focus-visible:outline-none dark:hover:bg-white/[0.03]"
          )}
        >
          {content}
        </Link>
      ) : (
        <div className={rowClass}>{content}</div>
      )}
    </li>
  )
}

function Cell({
  primary,
  secondary,
  secondaryClassName = "text-muted-foreground",
}: {
  primary: ReactNode
  secondary: ReactNode
  secondaryClassName?: string
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[14.5px] font-medium tabular-nums">{primary}</span>
      <span className={cn("truncate text-[13px] tabular-nums", secondaryClassName)}>
        {secondary}
      </span>
    </span>
  )
}

function matchesView(contract: ContractRow, view: View): boolean {
  if (view === "all") return true
  if (view === "renewing") return needsRenewalAttention(contract)
  if (["full_service", "priority_care", "preventive"].includes(view)) {
    return contract.properties.contractType === view
  }
  return contract.properties.status === view
}

function compareContracts(left: ContractRow, right: ContractRow, sort: Sort): number {
  if (sort === "number") {
    return right.properties.number.localeCompare(left.properties.number, undefined, {
      numeric: true,
    })
  }
  if (sort === "customer") {
    return (left.links.customer?.properties.name ?? "").localeCompare(
      right.links.customer?.properties.name ?? ""
    )
  }
  if (sort === "response") {
    return left.properties.responseTargetMinutes - right.properties.responseTargetMinutes
  }
  const priority = contractPriority(right) - contractPriority(left)
  return priority || dateValue(left.properties.endsOn) - dateValue(right.properties.endsOn)
}

function contractPriority(contract: ContractRow): number {
  if (contract.properties.status === "expired") return 60
  if (needsRenewalAttention(contract)) return 50
  if (contract.properties.status === "draft") return 30
  return 10
}

function needsRenewalAttention(contract: ContractRow): boolean {
  const days = daysUntil(contract.properties.endsOn)
  return (
    contract.properties.status === "expiring" ||
    contract.properties.status === "expired" ||
    days <= 60
  )
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`
}

function renewalLabel(value: string | Date): string {
  const days = daysUntil(value)
  if (days < 0) return `Ended ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago`
  if (days === 0) return "Ends today"
  if (days === 1) return "1 day left"
  return `${days} days left`
}

function renewalTone(contract: ContractRow): string {
  if (contract.properties.status === "expired" || daysUntil(contract.properties.endsOn) < 0) {
    return "font-medium text-destructive"
  }
  if (needsRenewalAttention(contract)) return "font-medium text-[color:var(--warning)]"
  return "text-muted-foreground"
}

function monthYear(value: string | Date): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(
    new Date(value)
  )
}

function daysUntil(value: string | Date): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(value)
  target.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000)
}

function dateValue(value: string | Date): number {
  return new Date(value).getTime()
}
