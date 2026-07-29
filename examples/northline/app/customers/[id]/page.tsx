import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { ArrowLeft, ChevronRight, Mail } from "lucide-react"
import type { ReactNode } from "react"
import { useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { CustomerAccount } from "../../../ontology/customer-account"
import { Equipment } from "../../../ontology/equipment"
import { Facility } from "../../../ontology/facility"
import { ServiceCase } from "../../../ontology/service-case"
import { ServiceContract } from "../../../ontology/service-contract"
import {
  deadlineLabel,
  formatDate,
  formatRelativeTime,
  humanize,
  QueryState,
  StatusIndicator,
} from "../../_components/ui"

export default function CustomerDetailPage() {
  const { id = "" } = useParams<{ id: string }>()
  const customerQuery = useMemo(
    () =>
      objects(CustomerAccount)
        .query()
        .where((customer) => customer.p.id.eq(id)),
    [id]
  )
  const customerResult = useObjectsQuery(customerQuery)
  const facilitiesResult = useObjectsQuery(
    objects(Facility).query().expand(Facility.l.customer).limit(100)
  )
  const equipmentResult = useObjectsQuery(
    objects(Equipment).query().expand(Equipment.l.facility).limit(200)
  )
  const casesResult = useObjectsQuery(
    objects(ServiceCase)
      .query()
      .expand(ServiceCase.l.customer)
      .expand(ServiceCase.l.facility)
      .expand(ServiceCase.l.equipment)
      .limit(100)
  )
  const contractsResult = useObjectsQuery(
    objects(ServiceContract)
      .query()
      .expand(ServiceContract.l.customer)
      .expand(ServiceContract.l.coveredFacilities, { limit: 10 })
      .limit(100)
  )
  const customer = customerResult.data?.objects[0]
  const facilities = (facilitiesResult.data?.objects ?? []).filter(
    (facility) => facility.links.customer?.primaryId === id
  )
  const facilityIds = new Set(facilities.map((facility) => facility.primaryId))
  const equipment = (equipmentResult.data?.objects ?? []).filter((asset) =>
    facilityIds.has(asset.links.facility?.primaryId ?? "")
  )
  const cases = (casesResult.data?.objects ?? []).filter(
    (serviceCase) => serviceCase.links.customer?.primaryId === id
  )
  const activeCases = cases
    .filter((serviceCase) => !["closed", "cancelled"].includes(serviceCase.properties.status))
    .sort((left, right) => casePriority(right) - casePriority(left))
  const contracts = (contractsResult.data?.objects ?? []).filter(
    (contract) => contract.links.customer?.primaryId === id
  )
  const activeContracts = contracts.filter((contract) =>
    ["active", "expiring"].includes(contract.properties.status)
  )
  const primaryContract = activeContracts[0] ?? contracts[0]
  const slaRisks = activeCases.filter((serviceCase) =>
    ["at_risk", "breached"].includes(serviceCase.properties.slaStatus)
  ).length
  const loading =
    customerResult.isLoading ||
    facilitiesResult.isLoading ||
    equipmentResult.isLoading ||
    casesResult.isLoading ||
    contractsResult.isLoading
  const error =
    customerResult.isError ||
    facilitiesResult.isError ||
    equipmentResult.isError ||
    casesResult.isError ||
    contractsResult.isError

  return (
    <QueryState
      loading={loading}
      error={error}
      empty={!customer}
      emptyMessage="Customer account not found."
    >
      {customer ? (
        <div className="pb-8">
          <Link
            to="/customers"
            className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-primary transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" strokeWidth={1.8} /> Customers
          </Link>

          <header className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex min-w-0 items-start gap-5 max-sm:flex-col">
              <span className="grid size-[72px] shrink-0 place-items-center rounded-full bg-primary/15 text-2xl font-semibold tracking-[-0.04em] text-primary sm:size-[82px] sm:text-[28px]">
                {initials(customer.properties.name)}
              </span>
              <div className="min-w-0 pt-0.5">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <StatusIndicator value={customer.properties.serviceTier} />
                  <StatusIndicator value={customer.properties.status} />
                </div>
                <h1 className="mt-4 text-[34px] leading-[1.08] font-semibold tracking-[-0.045em] text-foreground sm:text-[38px]">
                  {customer.properties.name}
                </h1>
                <p className="mt-2.5 text-sm leading-6 text-muted-foreground">
                  Northline service relationship across {facilities.length}{" "}
                  {pluralize("facility", facilities.length)} and {equipment.length} connected{" "}
                  {pluralize("asset", equipment.length)}.
                </p>
              </div>
            </div>

            <div className="pt-1 lg:justify-self-end">
              <p className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
                Authorization contact
              </p>
              <strong className="mt-2 block text-base font-semibold">
                {customer.properties.primaryContactName ?? "No contact assigned"}
              </strong>
              <span className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                <Mail className="size-4 shrink-0" strokeWidth={1.7} />
                <span className="truncate">
                  {customer.properties.primaryContactEmail ?? "No email available"}
                </span>
              </span>
              {customer.properties.primaryContactEmail ? (
                <a
                  href={`mailto:${customer.properties.primaryContactEmail}`}
                  className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-primary bg-card px-5 text-sm font-semibold text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                >
                  <Mail className="size-4" strokeWidth={1.7} /> Email contact
                </a>
              ) : null}
            </div>
          </header>

          <dl className="mt-7 mb-6 flex flex-wrap items-stretch">
            <RelationshipSignal label="Open case">{activeCases.length}</RelationshipSignal>
            <RelationshipSignal label="SLA risk" tone={slaRisks > 0 ? "critical" : "default"}>
              {slaRisks}
            </RelationshipSignal>
            <RelationshipSignal label="Connected assets">{equipment.length}</RelationshipSignal>
            <RelationshipSignal label="Active contract">
              {activeContracts.length}
            </RelationshipSignal>
          </dl>

          <section className="overflow-hidden rounded-lg border border-border/90 bg-card">
            <header className="px-5 pt-5 pb-4 sm:px-6">
              <h2 className="text-base font-semibold tracking-[-0.015em]">
                Current service exposure
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Customer impact and response commitments requiring attention.
              </p>
            </header>
            <div className="mx-5 border-t border-border/85 sm:mx-6">
              {activeCases.map((serviceCase) => (
                <Link
                  key={serviceCase.primaryId}
                  to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
                  className="group grid items-center gap-4 border-b border-border/80 py-4 last:border-b-0 hover:bg-accent/45 max-md:grid-cols-[84px_minmax(0,1fr)] md:-mx-3 md:grid-cols-[150px_minmax(0,1fr)_150px_auto] md:px-3"
                >
                  <EquipmentThumbnail
                    equipmentName={serviceCase.links.equipment?.properties.name ?? "Equipment"}
                    equipmentType={serviceCase.links.equipment?.properties.equipmentType}
                    variant="case"
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
                      <strong className="font-mono text-sm font-semibold">
                        {serviceCase.properties.number}
                      </strong>
                      <StatusIndicator value={serviceCase.properties.severity} />
                    </span>
                    <span className="mt-2 block text-base font-semibold tracking-[-0.01em] group-hover:text-primary">
                      {serviceCase.properties.title}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {serviceCase.links.facility?.properties.name ?? "Facility"} ·{" "}
                      {serviceCase.links.equipment?.properties.name ?? "Equipment"}
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5">
                      <StatusIndicator value={serviceCase.properties.status} />
                      {serviceCase.properties.ownerName ? (
                        <span className="text-xs text-muted-foreground">
                          {serviceCase.properties.ownerName}
                          {serviceCase.properties.status === "in_service" ? " on site" : ""}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="max-md:col-start-2 md:text-left">
                    <strong
                      className={`block font-mono text-sm font-semibold ${deadlineTone(
                        serviceCase.properties.slaStatus
                      )}`}
                    >
                      {deadlineLabel(serviceCase.properties.responseDeadline)}
                    </strong>
                    <StatusIndicator value={serviceCase.properties.slaStatus} className="mt-2" />
                  </span>
                  <span className="flex items-center justify-end gap-5 max-md:col-start-2 max-md:justify-start">
                    <span className="inline-flex h-10 items-center rounded-md border border-primary px-5 text-sm font-semibold text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                      Open service case
                    </span>
                    <ChevronRight
                      className="size-5 text-foreground transition-transform group-hover:translate-x-0.5"
                      strokeWidth={1.7}
                    />
                  </span>
                </Link>
              ))}
              {activeCases.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No active service cases.
                </p>
              ) : null}
            </div>
          </section>

          <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(330px,1fr)]">
            <section className="overflow-hidden rounded-lg border border-border/90 bg-card">
              <header className="px-5 pt-5 pb-3 sm:px-6">
                <h2 className="text-base font-semibold tracking-[-0.015em]">
                  Facilities &amp; equipment
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {facilities.length} {pluralize("facility", facilities.length)} ·{" "}
                  {equipment.length} {pluralize("asset", equipment.length)}
                </p>
              </header>

              <div className="mx-5 border-t border-border/85 sm:mx-6">
                {facilities.map((facility) => {
                  const facilityEquipment = equipment.filter(
                    (asset) => asset.links.facility?.primaryId === facility.primaryId
                  )
                  return (
                    <div key={facility.primaryId}>
                      <div className="flex items-start justify-between gap-5 py-5">
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold tracking-[0.14em] text-primary uppercase">
                            Facility
                          </p>
                          <h3 className="mt-2 text-sm font-semibold tracking-[-0.01em]">
                            {facility.properties.name}
                          </h3>
                          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                            {facility.properties.addressLine}, {facility.properties.city},{" "}
                            {facility.properties.state} {facility.properties.postalCode}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {humanize(facility.properties.territory)} territory ·{" "}
                            {humanize(facility.properties.status)}
                          </p>
                        </div>
                        <StatusIndicator
                          value={facility.properties.criticality}
                          className="mt-0.5 shrink-0"
                        />
                      </div>

                      <div className="divide-y divide-border/80 border-t border-border/85">
                        {facilityEquipment.map((asset) => (
                          <Link
                            key={asset.primaryId}
                            to={`/equipment/${encodeURIComponent(asset.primaryId)}`}
                            className="group grid items-center gap-4 py-3.5 hover:bg-accent/45 max-sm:grid-cols-[80px_minmax(0,1fr)] sm:-mx-3 sm:grid-cols-[108px_minmax(0,1fr)_150px_24px] sm:px-3"
                          >
                            <EquipmentThumbnail
                              equipmentName={asset.properties.name}
                              equipmentType={asset.properties.equipmentType}
                              variant="asset"
                            />
                            <span className="min-w-0">
                              <strong className="block text-sm font-semibold group-hover:text-primary">
                                {asset.properties.name}
                              </strong>
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {asset.properties.manufacturer} · {asset.properties.model}
                              </span>
                              <span className="mt-1.5 block font-mono text-xs text-muted-foreground">
                                {asset.properties.serialNumber}
                              </span>
                            </span>
                            <span className="max-sm:col-start-2">
                              <StatusIndicator value={asset.properties.health} />
                              <span className="mt-1.5 block text-xs text-muted-foreground">
                                Seen {formatRelativeTime(asset.properties.lastSeenAt)}
                              </span>
                            </span>
                            <ChevronRight
                              className="size-5 text-foreground transition-transform group-hover:translate-x-0.5 max-sm:col-start-2"
                              strokeWidth={1.7}
                            />
                          </Link>
                        ))}
                      </div>
                    </div>
                  )
                })}
                {facilities.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    No facilities connected to this account.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-border/90 bg-card">
              <header className="px-5 pt-5 sm:px-6">
                <h2 className="text-base font-semibold tracking-[-0.015em]">Coverage commitment</h2>
              </header>
              {primaryContract ? (
                <div className="px-5 pt-2 pb-4 sm:px-6">
                  <div className="flex items-center justify-between gap-4">
                    <strong className="font-mono text-xs font-semibold">
                      {primaryContract.properties.number}
                    </strong>
                    <StatusIndicator value={primaryContract.properties.status} />
                  </div>
                  <h3 className="mt-3 text-base font-semibold">
                    {primaryContract.properties.name}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {humanize(primaryContract.properties.contractType)} ·{" "}
                    {coverageLabel(primaryContract.properties.coverageHours)} coverage
                  </p>

                  <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 text-xs">
                    <Detail label="Response">
                      {duration(primaryContract.properties.responseTargetMinutes)}
                    </Detail>
                    <Detail label="Resolution">
                      {duration(primaryContract.properties.resolutionTargetMinutes)}
                    </Detail>
                    <Detail label="Labor">
                      {primaryContract.properties.includedLabor ? "Included" : "Excluded"}
                    </Detail>
                    <Detail label="Approval threshold">
                      {compactMoney(primaryContract.properties.approvalThreshold)}
                    </Detail>
                  </dl>
                  <p className="mt-5 text-xs text-muted-foreground">
                    Major components{" "}
                    {primaryContract.properties.majorComponentsExcluded ? "excluded" : "included"}
                  </p>

                  <div className="mt-5 border-t border-border/85 pt-4">
                    <p className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                      Renews
                    </p>
                    <strong className="mt-1.5 block font-mono text-sm font-semibold">
                      {formatDate(primaryContract.properties.endsOn)}
                    </strong>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {daysRemaining(primaryContract.properties.endsOn)} days remaining
                    </span>
                  </div>

                  <Link
                    to="/contracts"
                    className="mt-3 flex items-center justify-between border-t border-border/85 pt-4 text-sm font-semibold text-primary hover:text-foreground"
                  >
                    View contract portfolio
                    <ChevronRight className="size-5" strokeWidth={1.7} />
                  </Link>
                </div>
              ) : (
                <p className="px-6 py-10 text-center text-sm text-muted-foreground">
                  No coverage commitment is connected to this account.
                </p>
              )}
            </section>
          </div>
        </div>
      ) : null}
    </QueryState>
  )
}

function RelationshipSignal({
  label,
  tone = "default",
  children,
}: {
  label: string
  tone?: "default" | "critical"
  children: ReactNode
}) {
  const toneClass = tone === "critical" ? "text-destructive" : "text-foreground"
  return (
    <div className="flex min-w-[160px] flex-col border-border/90 px-3 py-1 first:pl-0 sm:min-w-[190px] sm:border-r sm:px-8 sm:first:pl-3 sm:last:border-r-0">
      <dt
        className={`order-2 mt-1 text-sm ${
          tone === "critical" ? toneClass : "text-muted-foreground"
        }`}
      >
        {label}
      </dt>
      <dd className={`order-1 font-mono text-xl font-semibold ${toneClass}`}>{children}</dd>
    </div>
  )
}

function EquipmentThumbnail({
  equipmentName,
  equipmentType,
  variant,
}: {
  equipmentName: string
  equipmentType: string | undefined
  variant: "case" | "asset"
}) {
  const illustration = equipmentIllustration(equipmentName, equipmentType)
  const sizeClass =
    variant === "case"
      ? "h-[106px] w-[132px] max-md:h-[76px] max-md:w-[76px]"
      : "h-[76px] w-[96px] max-sm:h-[72px] max-sm:w-[72px]"
  return (
    <span
      className={`grid shrink-0 place-items-center overflow-hidden rounded-md border border-border/80 bg-secondary/55 ${sizeClass}`}
    >
      {illustration ? (
        <img
          src={illustration.src}
          alt=""
          className={
            illustration.contain ? "size-full object-contain p-1.5" : "size-full object-cover"
          }
        />
      ) : (
        <span className="font-mono text-xs font-semibold text-primary">
          {initials(equipmentName)}
        </span>
      )}
    </span>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 font-medium text-foreground">{children}</dd>
    </div>
  )
}

function equipmentIllustration(equipmentName: string, equipmentType: string | undefined) {
  const normalized = equipmentName.toLowerCase()
  if (normalized.includes("rtu-2")) return { src: "/illustrations/rtu-2.webp", contain: false }
  if (normalized.includes("rtu-7")) return { src: "/illustrations/rtu-7.webp", contain: false }
  if (normalized.includes("ahu-3") || equipmentType === "air_handler") {
    return { src: "/illustrations/ahu-3.webp", contain: false }
  }
  if (normalized.includes("controller") || equipmentType === "controller") {
    return { src: "/illustrations/building-controller.webp", contain: false }
  }
  if (equipmentType === "boiler") {
    return { src: "/illustrations/boiler-2.webp", contain: true }
  }
  return undefined
}

function casePriority(serviceCase: {
  properties: { severity: string; slaStatus: string }
}): number {
  const severity = { critical: 40, high: 30, medium: 20, low: 10 }[
    serviceCase.properties.severity as "critical" | "high" | "medium" | "low"
  ]
  const sla = { breached: 30, at_risk: 20, on_track: 0, met: -10 }[
    serviceCase.properties.slaStatus as "breached" | "at_risk" | "on_track" | "met"
  ]
  return severity + sla
}

function deadlineTone(status: string): string {
  if (status === "breached") return "text-destructive"
  if (status === "at_risk") return "text-[color:var(--warning)]"
  return "text-foreground"
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`
}

function compactMoney(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value)
}

function daysRemaining(value: string | Date): number {
  const difference = new Date(value).getTime() - Date.now()
  return Math.max(0, Math.ceil(difference / 86_400_000))
}

function coverageLabel(value: string): string {
  return value === "24_7" ? "24/7" : humanize(value)
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`
}
