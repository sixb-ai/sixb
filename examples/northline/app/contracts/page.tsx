import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Input } from "@sixb/ui/components"
import { ArrowUpDown, ChevronRight, Search, ShieldCheck } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { ServiceContract } from "../../ontology/service-contract"
import { formatDate, formatMoney, humanize, QueryState } from "../_components/ui"

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
          contract.links.customer?.properties.name,
          ...contract.links.coveredFacilities.map((facility) => facility.properties.name),
        ].some((value) => value?.toLowerCase().includes(normalized))
      })
      .sort((left, right) => compareContracts(left, right, sort))
  }, [allRows, search, sort, view])

  return (
    <div className="pb-8">
      <header className="mb-6 flex items-start justify-between gap-6 max-sm:flex-col">
        <div className="min-w-0">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
            Coverage commitments
          </p>
          <h1 className="text-[32px] leading-9 font-semibold tracking-[-0.035em] text-foreground max-sm:text-[28px]">
            Contracts
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Response obligations, commercial coverage, and renewal exposure for every serviced
            facility.
          </p>
        </div>
        <div className="shrink-0 text-right max-sm:text-left">
          <strong className="block font-mono text-xl font-semibold">{renewalRisks}</strong>
          <span className="text-xs text-muted-foreground">renewal risks</span>
        </div>
      </header>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <label className="relative block">
          <span className="sr-only">Search contracts</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search contracts, customers, or facilities"
            className="h-12 rounded-lg border-border/90 bg-card pl-11 text-sm shadow-none focus-visible:ring-2"
          />
        </label>

        <label className="relative block">
          <span className="sr-only">Sort contracts</span>
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

      <div className="mt-4 flex gap-2 overflow-x-auto pb-2" aria-label="Contract views">
        {views.map(([value, label]) => {
          const count = allRows.filter((contract) => matchesView(contract, value)).length
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
          loading={contracts.isLoading}
          error={contracts.isError}
          empty={rows.length === 0}
          emptyMessage="No service contracts match this view."
        >
          <div className="grid gap-2.5">
            {rows.map((contract) => (
              <ContractWorklistRow key={contract.primaryId} contract={contract} />
            ))}
          </div>
        </QueryState>
      </section>
    </div>
  )
}

function ContractWorklistRow({ contract }: { contract: ContractRow }) {
  const facilities = contract.links.coveredFacilities
  const customer = contract.links.customer
  const href = customer ? `/customers/${encodeURIComponent(customer.primaryId)}` : undefined

  return (
    <Link
      to={href ?? "/contracts"}
      aria-disabled={!href}
      tabIndex={href ? undefined : -1}
      className={`group relative overflow-hidden rounded-xl border border-border/85 bg-card transition-[border-color,background-color,box-shadow] hover:border-primary/55 hover:bg-primary/[0.025] hover:shadow-[0_1px_2px_rgba(13,32,39,0.04)] focus-visible:border-primary/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        href ? "cursor-pointer" : ""
      }`}
      onClick={(event) => {
        if (!href) event.preventDefault()
      }}
    >
      <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-4 gap-y-4 px-3.5 py-3.5 2xl:grid-cols-[82px_minmax(250px,1.2fr)_minmax(185px,0.7fr)_minmax(210px,0.82fr)_130px_150px_18px] 2xl:pr-5">
        <ContractDocument number={contract.properties.number} />

        <div className="min-w-0 self-center">
          <div className="flex flex-wrap items-center gap-2.5">
            <strong className="font-mono text-xs font-semibold tracking-[-0.01em]">
              {contract.properties.number}
            </strong>
            <ContractStatusIndicator status={contract.properties.status} />
          </div>
          <p className="mt-1.5 truncate text-sm font-semibold tracking-[-0.012em] text-foreground">
            {contract.properties.name}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {humanize(contract.properties.contractType)} · {coverageHoursLabel(contract)}
          </p>
        </div>

        <div className="col-start-2 min-w-0 border-t border-border/65 pt-3 2xl:col-start-auto 2xl:border-0 2xl:pt-0">
          {customer ? (
            <span className="block truncate text-xs font-semibold text-foreground group-hover:text-primary">
              {customer.properties.name}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Customer unavailable</span>
          )}
          <span className="mt-1.5 block truncate text-[11px] text-muted-foreground">
            {facilities[0]?.properties.name ?? "No covered facility"}
            {facilities.length > 1 ? ` +${facilities.length - 1} more` : ""}
          </span>
        </div>

        <div className="col-start-2 min-w-0 2xl:col-start-auto">
          <strong className="block text-xs font-medium text-foreground">
            {contract.properties.includedLabor ? "Labor included" : "Labor excluded"}
          </strong>
          <span className="mt-1.5 block text-[11px] text-muted-foreground">
            {contract.properties.majorComponentsExcluded
              ? "Major components excluded"
              : "Major components included"}
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            Approval threshold {formatMoney(contract.properties.approvalThreshold)}
          </span>
        </div>

        <div className="col-start-2 2xl:col-start-auto">
          <strong className="block font-mono text-sm font-semibold tracking-[-0.02em]">
            {duration(contract.properties.responseTargetMinutes)}
          </strong>
          <span className="mt-1 block text-[10px] text-muted-foreground">response target</span>
          <span className="mt-1.5 block text-[11px] text-foreground/80">
            {duration(contract.properties.resolutionTargetMinutes)} resolution
          </span>
        </div>

        <div className="col-start-2 min-w-0 2xl:col-start-auto 2xl:text-right">
          <strong className={`block text-xs font-medium ${renewalTone(contract)}`}>
            {formatDate(contract.properties.endsOn)}
          </strong>
          <span className={`mt-1.5 block text-[11px] font-medium ${renewalTone(contract)}`}>
            {renewalLabel(contract.properties.endsOn)}
          </span>
          <span className="mt-1 block text-[10px] text-muted-foreground">
            Started {formatDate(contract.properties.startsOn)}
          </span>
        </div>

        {href ? (
          <ChevronRight
            className="absolute right-4 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary 2xl:static"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className="absolute right-4 size-4 text-muted-foreground/40 2xl:static"
            strokeWidth={1.8}
            aria-hidden="true"
          />
        )}
      </div>
    </Link>
  )
}

function ContractDocument({ number }: { number: string }) {
  return (
    <span className="grid h-[82px] w-[76px] place-items-center rounded-lg border border-primary/10 bg-secondary/75">
      <span className="relative grid h-[66px] w-[50px] place-items-center overflow-hidden rounded-[3px] border border-border bg-card shadow-[0_2px_4px_rgba(13,32,39,0.08)]">
        <span className="absolute top-0 right-0 size-3 border-b border-l border-border bg-secondary" />
        <ShieldCheck className="size-5 text-primary" strokeWidth={1.6} aria-hidden="true" />
        <strong className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[7px] font-semibold text-foreground">
          {number}
        </strong>
      </span>
    </span>
  )
}

function ContractStatusIndicator({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "text-[color:var(--success)] before:bg-[color:var(--success)]"
      : status === "expiring"
        ? "text-[color:var(--warning)] before:bg-[color:var(--warning)]"
        : status === "expired"
          ? "text-destructive before:bg-destructive"
          : "text-muted-foreground before:bg-muted-foreground/65"
  return (
    <span
      className={`inline-flex items-center gap-2 text-xs font-medium before:size-1.5 before:rounded-full ${tone}`}
    >
      {humanize(status)}
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

function coverageHoursLabel(contract: ContractRow): string {
  return contract.properties.coverageHours === "24_7" ? "24/7 coverage" : "Business-hours coverage"
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`
}

function renewalLabel(value: string | Date): string {
  const days = daysUntil(value)
  if (days < 0) return `${Math.abs(days)} days expired`
  if (days === 0) return "Renews today"
  if (days === 1) return "1 day remaining"
  return `${days} days remaining`
}

function renewalTone(contract: ContractRow): string {
  if (contract.properties.status === "expired" || daysUntil(contract.properties.endsOn) < 0) {
    return "text-destructive"
  }
  if (needsRenewalAttention(contract)) return "text-[color:var(--warning)]"
  return "text-foreground"
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
