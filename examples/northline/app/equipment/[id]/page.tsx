import { useObjectsQuery, useTelemetryHistoryQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { ArrowLeft, ChevronRight, Radio } from "lucide-react"
import type { ReactNode } from "react"
import { useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { BuildingAlarm } from "../../../ontology/building-alarm"
import { Equipment } from "../../../ontology/equipment"
import { Quote } from "../../../ontology/quote"
import { ServiceCase } from "../../../ontology/service-case"
import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  humanize,
  QueryState,
  StatusIndicator,
} from "../../_components/ui"

const alarmsQuery = objects(BuildingAlarm).query().expand(BuildingAlarm.l.equipment).limit(100)
const casesQuery = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  .limit(100)
const quotesQuery = objects(Quote).query().expand(Quote.l.serviceCase).limit(100)

type MeasurementPoint = { value: number | null; at: string }

export default function EquipmentDetailPage() {
  const { id = "" } = useParams<{ id: string }>()
  const equipmentQuery = useMemo(
    () =>
      objects(Equipment)
        .query()
        .where((equipment) => equipment.p.id.eq(id))
        .expand(Equipment.l.facility),
    [id]
  )
  const equipmentResult = useObjectsQuery(equipmentQuery)
  const alarmsResult = useObjectsQuery(alarmsQuery)
  const casesResult = useObjectsQuery(casesQuery)
  const quotesResult = useObjectsQuery(quotesQuery)
  const supply = useTelemetryHistoryQuery({
    objectType: Equipment,
    objectId: id,
    property: Equipment.p.supplyAirTemperature,
    limit: 24,
    order: "desc",
    enabled: Boolean(id),
  })
  const returnAir = useTelemetryHistoryQuery({
    objectType: Equipment,
    objectId: id,
    property: Equipment.p.returnAirTemperature,
    limit: 24,
    order: "desc",
    enabled: Boolean(id),
  })
  const current = useTelemetryHistoryQuery({
    objectType: Equipment,
    objectId: id,
    property: Equipment.p.compressorCurrent,
    limit: 24,
    order: "desc",
    enabled: Boolean(id),
  })
  const equipment = equipmentResult.data?.objects[0]
  const alarms = (alarmsResult.data?.objects ?? [])
    .filter((alarm) => alarm.links.equipment?.primaryId === id)
    .sort(
      (left, right) =>
        new Date(right.properties.observedAt).getTime() -
        new Date(left.properties.observedAt).getTime()
    )
  const cases = (casesResult.data?.objects ?? [])
    .filter((serviceCase) => serviceCase.links.equipment?.primaryId === id)
    .sort(
      (left, right) =>
        new Date(right.properties.detectedAt).getTime() -
        new Date(left.properties.detectedAt).getTime()
    )
  const activeCase = cases.find(
    (serviceCase) => !["closed", "cancelled"].includes(serviceCase.properties.status)
  )
  const activeQuote = (quotesResult.data?.objects ?? []).find(
    (quote) => quote.links.serviceCase?.primaryId === activeCase?.primaryId
  )
  const latestAlarm = alarms[0]
  const customerHref = activeCase?.links.customer
    ? `/customers/${encodeURIComponent(activeCase.links.customer.primaryId)}`
    : undefined

  return (
    <QueryState
      loading={equipmentResult.isLoading}
      error={equipmentResult.isError}
      empty={!equipment}
      emptyMessage="Equipment not found."
    >
      {equipment ? (
        <div className="pb-8">
          <Link
            to="/equipment"
            className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-primary transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" strokeWidth={1.8} /> Equipment
          </Link>

          <header className="grid items-stretch gap-7 lg:grid-cols-[280px_minmax(0,1fr)]">
            <EquipmentHero
              equipmentName={equipment.properties.name}
              equipmentType={equipment.properties.equipmentType}
            />

            <div className="flex min-w-0 flex-col justify-between py-1">
              <div className="flex items-start justify-between gap-6 max-sm:flex-col">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <StatusIndicator value={equipment.properties.health} />
                    <StatusIndicator value={equipment.properties.criticality} />
                  </div>
                  <h1 className="mt-3 text-[42px] leading-none font-semibold tracking-[-0.05em] text-foreground max-sm:text-[34px]">
                    {equipment.properties.name}
                  </h1>
                  <p className="mt-3 text-base font-semibold">
                    {equipment.properties.manufacturer} · {equipment.properties.model}
                  </p>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {humanize(equipment.properties.equipmentType)} at{" "}
                    {equipment.links.facility?.properties.name ?? "Facility"}
                  </p>
                  <p className="mt-2.5 font-mono text-xs text-foreground">
                    {equipment.properties.serialNumber}
                  </p>
                </div>
                {customerHref ? (
                  <Link
                    to={customerHref}
                    className="inline-flex h-10 shrink-0 items-center justify-center rounded-md border border-primary bg-card px-5 text-sm font-semibold text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                  >
                    View facility
                  </Link>
                ) : null}
              </div>

              <dl className="mt-5 grid border-t border-border/90 pt-4 sm:grid-cols-2 xl:grid-cols-[1.45fr_0.9fr_0.9fr_0.72fr]">
                <SummaryDetail
                  label="Condition"
                  tone={equipment.properties.health === "healthy" ? "default" : "critical"}
                >
                  {conditionLabel(equipment.properties.healthReason)}
                </SummaryDetail>
                <SummaryDetail label="Controls signal">
                  Seen {formatRelativeTime(equipment.properties.lastSeenAt)}
                </SummaryDetail>
                <SummaryDetail label="Installed">
                  {formatDate(equipment.properties.installedOn)}
                </SummaryDetail>
                <SummaryDetail label="Asset age">
                  {assetAge(equipment.properties.installedOn)}
                </SummaryDetail>
              </dl>
            </div>
          </header>

          <section className="mt-5 overflow-hidden rounded-lg border border-border/90 bg-card">
            <header className="px-5 pt-4 pb-3 sm:px-6">
              <h2 className="text-base font-semibold tracking-[-0.015em]">
                Current service response
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Customer-impacting work currently connected to this asset.
              </p>
            </header>
            <div className="mx-5 border-t border-border/85 sm:mx-6">
              {activeCase ? (
                <Link
                  to={`/service-cases/${encodeURIComponent(activeCase.primaryId)}`}
                  className="group grid items-center gap-4 py-4 hover:bg-accent/45 xl:-mx-3 xl:grid-cols-[170px_minmax(0,1.35fr)_210px_175px_auto] xl:px-3"
                >
                  <span className="flex flex-wrap items-center gap-4">
                    <strong className="font-mono text-sm font-semibold">
                      {activeCase.properties.number}
                    </strong>
                    <StatusIndicator value={activeCase.properties.severity} />
                  </span>
                  <span className="min-w-0">
                    <strong className="block text-sm font-semibold group-hover:text-primary">
                      {activeCase.properties.title}
                    </strong>
                    <span className="mt-1.5 block truncate text-xs text-muted-foreground">
                      {activeCase.links.customer?.properties.name ?? "Customer"} ·{" "}
                      {activeCase.links.facility?.properties.name ?? "Facility"}
                    </span>
                  </span>
                  <span>
                    <StatusIndicator value={activeCase.properties.status} />
                  </span>
                  <span>
                    <strong className="block text-sm font-semibold">
                      {activeCase.properties.nextAction ?? "Review service response"}
                    </strong>
                    {activeQuote ? (
                      <span className="mt-1.5 block text-xs text-muted-foreground">
                        Quote {activeQuote.properties.number} ·{" "}
                        {compactMoney(activeQuote.properties.amount)}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center justify-end gap-5 max-xl:justify-start">
                    <StatusIndicator value={activeCase.properties.slaStatus} />
                    <span className="inline-flex h-10 items-center rounded-md border border-primary px-4 text-sm font-semibold text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                      Open service case
                    </span>
                    <ChevronRight
                      className="size-5 transition-transform group-hover:translate-x-0.5"
                      strokeWidth={1.7}
                    />
                  </span>
                </Link>
              ) : (
                <p className="py-9 text-center text-sm text-muted-foreground">
                  No active service response is connected to this asset.
                </p>
              )}
            </div>
          </section>

          <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(330px,0.95fr)]">
            <section className="overflow-hidden rounded-lg border border-border/90 bg-card">
              <header className="flex items-start justify-between gap-5 px-5 pt-4 pb-3 sm:px-6">
                <div>
                  <h2 className="text-base font-semibold tracking-[-0.015em]">
                    Operating evidence
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Latest building-controls readings across the last 24 hours.
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <Radio className="size-4 text-[color:var(--success)]" strokeWidth={1.8} />
                  Reporting · Seen {formatRelativeTime(equipment.properties.lastSeenAt)}
                </span>
              </header>
              <div className="mx-5 divide-y divide-border/80 border-t border-border/85 sm:mx-6">
                <Measurement
                  label="Supply air temperature"
                  unit="°C"
                  points={supply.data ?? []}
                  expectedLow={18}
                  expectedHigh={24}
                  rangeLabel="Expected 18–24 °C"
                  highLabel="Above expected range"
                  lowLabel="Below expected range"
                />
                <Measurement
                  label="Return air temperature"
                  unit="°C"
                  points={returnAir.data ?? []}
                  expectedLow={19}
                  expectedHigh={25}
                  rangeLabel="Expected 19–25 °C"
                  highLabel="Above expected range"
                  lowLabel="Below expected range"
                />
                <Measurement
                  label="Compressor current"
                  unit="A"
                  points={current.data ?? []}
                  expectedLow={24}
                  expectedHigh={34}
                  rangeLabel="Typical 24–34 A"
                  highLabel="Above baseline"
                  lowLabel="Below baseline"
                />
              </div>
            </section>

            <section
              id="asset-profile"
              className="overflow-hidden rounded-lg border border-border/90 bg-card"
            >
              <header className="px-5 pt-4 pb-3 sm:px-6">
                <h2 className="text-base font-semibold tracking-[-0.015em]">Asset profile</h2>
              </header>
              <div className="px-5 pb-4 sm:px-6">
                <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-2.5 border-t border-border/85 pt-4 text-xs">
                  <ProfileDetail label="Type">
                    {humanize(equipment.properties.equipmentType)}
                  </ProfileDetail>
                  <ProfileDetail label="Manufacturer">
                    {equipment.properties.manufacturer}
                  </ProfileDetail>
                  <ProfileDetail label="Model">{equipment.properties.model}</ProfileDetail>
                  <ProfileDetail label="Serial" mono>
                    {equipment.properties.serialNumber}
                  </ProfileDetail>
                  <ProfileDetail label="Facility">
                    {equipment.links.facility?.properties.name ?? "—"}
                  </ProfileDetail>
                  <ProfileDetail label="Installed">
                    {formatDate(equipment.properties.installedOn)}
                  </ProfileDetail>
                </dl>

                <div className="mt-5 border-t border-border/85 pt-4">
                  <p className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                    Latest alarm
                  </p>
                  {latestAlarm ? (
                    <div className="mt-3 flex items-start gap-3">
                      <Radio
                        className="mt-0.5 size-6 shrink-0 text-destructive"
                        strokeWidth={1.8}
                      />
                      <div className="min-w-0">
                        <strong className="block text-sm leading-5">
                          {latestAlarm.properties.message}
                        </strong>
                        <StatusIndicator value={latestAlarm.properties.status} className="mt-2" />
                        <span className="mt-1.5 block font-mono text-[11px] text-muted-foreground">
                          {formatDateTime(latestAlarm.properties.observedAt)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-muted-foreground">No alarms recorded.</p>
                  )}
                  <a
                    href="#service-history"
                    className="mt-4 flex items-center justify-between border-t border-border/85 pt-3 text-sm font-semibold text-primary hover:text-foreground"
                  >
                    View related service history
                    <ChevronRight className="size-5" strokeWidth={1.7} />
                  </a>
                </div>
              </div>
            </section>
          </div>

          <section
            id="service-history"
            className="mt-4 overflow-hidden rounded-lg border border-border/90 bg-card"
          >
            <header className="flex items-baseline gap-4 px-5 pt-4 pb-3 sm:px-6">
              <h2 className="text-base font-semibold tracking-[-0.015em]">Service history</h2>
              <span className="font-mono text-xs text-muted-foreground">
                {cases.length} {cases.length === 1 ? "case" : "cases"}
              </span>
            </header>
            <div className="mx-5 divide-y divide-border/80 border-t border-border/85 sm:mx-6">
              {cases.map((serviceCase) => (
                <Link
                  key={serviceCase.primaryId}
                  to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
                  className="group grid items-center gap-4 py-3.5 hover:bg-accent/45 xl:-mx-3 xl:grid-cols-[150px_minmax(0,1fr)_250px_130px_190px_20px] xl:px-3"
                >
                  <strong className="font-mono text-xs font-semibold">
                    {serviceCase.properties.number}
                  </strong>
                  <span className="truncate text-sm font-medium group-hover:text-primary">
                    {serviceCase.properties.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Detected {formatDateTime(serviceCase.properties.detectedAt)}
                  </span>
                  <StatusIndicator value={serviceCase.properties.severity} />
                  <StatusIndicator value={serviceCase.properties.status} />
                  <ChevronRight
                    className="size-5 transition-transform group-hover:translate-x-0.5"
                    strokeWidth={1.7}
                  />
                </Link>
              ))}
              {cases.length === 0 ? (
                <p className="py-9 text-center text-sm text-muted-foreground">
                  No service history is connected to this asset.
                </p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </QueryState>
  )
}

function EquipmentHero({
  equipmentName,
  equipmentType,
}: {
  equipmentName: string
  equipmentType: string
}) {
  const illustration = equipmentIllustration(equipmentName, equipmentType)
  return (
    <div className="grid min-h-[220px] place-items-center overflow-hidden rounded-lg border border-primary/20 bg-secondary/70">
      <img
        src={illustration.src}
        alt=""
        className={illustration.contain ? "size-full object-contain p-3" : "size-full object-cover"}
      />
      <span className="sr-only">{equipmentName}</span>
    </div>
  )
}

function SummaryDetail({
  label,
  children,
  tone = "default",
}: {
  label: string
  children: ReactNode
  tone?: "default" | "critical"
}) {
  return (
    <div className="border-border/90 py-1 pr-5 sm:border-r sm:px-5 sm:first:pl-0 sm:last:border-r-0">
      <dt className="text-[10px] font-medium text-muted-foreground">{label}</dt>
      <dd
        className={`mt-1 text-xs leading-5 font-semibold ${
          tone === "critical" ? "text-destructive" : "text-foreground"
        }`}
      >
        {children}
      </dd>
    </div>
  )
}

function ProfileDetail({
  label,
  children,
  mono = false,
}: {
  label: string
  children: ReactNode
  mono?: boolean
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-[11px] text-foreground" : "text-foreground"}>
        {children}
      </dd>
    </>
  )
}

function Measurement({
  label,
  unit,
  points,
  expectedLow,
  expectedHigh,
  rangeLabel,
  highLabel,
  lowLabel,
}: {
  label: string
  unit: string
  points: readonly MeasurementPoint[]
  expectedLow: number
  expectedHigh: number
  rangeLabel: string
  highLabel: string
  lowLabel: string
}) {
  const values = points
    .filter((point): point is { value: number; at: string } => typeof point.value === "number")
    .slice()
    .reverse()
  const latest = values.at(-1)
  const tone = measurementTone(latest?.value, expectedLow, expectedHigh)
  const status = latest
    ? latest.value > expectedHigh
      ? highLabel
      : latest.value < expectedLow
        ? lowLabel
        : "Within range"
    : "Awaiting telemetry"
  return (
    <div className="grid gap-4 py-4 lg:grid-cols-[190px_190px_minmax(240px,1fr)] lg:items-center">
      <div>
        <p className="text-xs font-medium">{label}</p>
        <strong className="mt-1.5 block font-mono text-2xl font-semibold tracking-[-0.025em]">
          {latest ? `${latest.value.toFixed(1)} ${unit}` : "—"}
        </strong>
      </div>
      <div>
        <EvidenceStatus tone={tone}>{status}</EvidenceStatus>
        <p className="mt-2 text-xs text-muted-foreground">{rangeLabel}</p>
      </div>
      <Trend
        values={values.map((point) => point.value)}
        expectedLow={expectedLow}
        expectedHigh={expectedHigh}
        tone={tone}
      />
    </div>
  )
}

function EvidenceStatus({
  tone,
  children,
}: {
  tone: "critical" | "success" | "muted"
  children: ReactNode
}) {
  const className = {
    critical: "text-destructive before:bg-destructive",
    success: "text-[color:var(--success)] before:bg-[color:var(--success)]",
    muted: "text-muted-foreground before:bg-muted-foreground/65",
  }[tone]
  return (
    <span
      className={`inline-flex items-center gap-2 text-xs font-medium before:size-1.5 before:rounded-full ${className}`}
    >
      {children}
    </span>
  )
}

function Trend({
  values,
  expectedLow,
  expectedHigh,
  tone,
}: {
  values: readonly number[]
  expectedLow: number
  expectedHigh: number
  tone: "critical" | "success" | "muted"
}) {
  if (values.length < 2) {
    return (
      <div className="flex h-14 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
        Trend available when controls history arrives
      </div>
    )
  }
  const width = 420
  const height = 58
  const domainMin = Math.min(...values, expectedLow) - 1
  const domainMax = Math.max(...values, expectedHigh) + 1
  const range = domainMax - domainMin || 1
  const y = (value: number) => 3 + (height - 12) - ((value - domainMin) / range) * (height - 12)
  const points = values
    .map((value, index) => {
      const x = 3 + (index / (values.length - 1)) * (width - 6)
      return `${x},${y(value)}`
    })
    .join(" ")
  const lastValue = values.at(-1) ?? values[0]
  const endX = width - 3
  const stroke = tone === "critical" ? "var(--destructive)" : "var(--primary)"
  const bandTop = y(expectedHigh)
  const bandHeight = Math.max(2, y(expectedLow) - bandTop)
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-14 w-full overflow-visible"
        role="img"
        aria-label="Recent measurement trend"
      >
        <rect
          x="0"
          y={bandTop}
          width={width}
          height={bandHeight}
          fill="var(--muted)"
          opacity="0.65"
        />
        <line
          x1="0"
          y1={y(expectedHigh)}
          x2={width}
          y2={y(expectedHigh)}
          stroke="var(--border)"
          strokeDasharray="4 4"
        />
        <line
          x1="0"
          y1={y(expectedLow)}
          x2={width}
          y2={y(expectedLow)}
          stroke="var(--border)"
          strokeDasharray="4 4"
        />
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx={endX} cy={y(lastValue)} r="3.5" fill={stroke} />
      </svg>
      <div className="flex justify-between font-mono text-[9px] text-muted-foreground">
        <span>24h ago</span>
        <span>12h ago</span>
        <span>Now</span>
      </div>
    </div>
  )
}

function equipmentIllustration(equipmentName: string, equipmentType: string) {
  const normalized = equipmentName.toLowerCase()
  if (normalized === "rtu-2") return { src: "/illustrations/rtu-2.webp", contain: false }
  if (normalized === "rtu-7") return { src: "/illustrations/rtu-7.webp", contain: false }
  if (equipmentType === "rooftop_unit") {
    return { src: "/illustrations/rtu-7.webp", contain: false }
  }
  if (equipmentType === "air_handler") {
    return { src: "/illustrations/ahu-3.webp", contain: false }
  }
  if (equipmentType === "controller") {
    return { src: "/illustrations/building-controller.webp", contain: false }
  }
  if (equipmentType === "boiler") {
    return { src: "/illustrations/boiler-2.webp", contain: true }
  }
  if (equipmentType === "chiller") {
    return { src: "/illustrations/chiller-1.webp", contain: false }
  }
  return { src: "/illustrations/heat-pump-4.webp", contain: false }
}

function measurementTone(
  value: number | undefined,
  expectedLow: number,
  expectedHigh: number
): "critical" | "success" | "muted" {
  if (value === undefined) return "muted"
  return value < expectedLow || value > expectedHigh ? "critical" : "success"
}

function conditionLabel(value: string | undefined): string {
  if (!value) return "No condition explanation"
  const normalized = value.replaceAll("_", " ").toLowerCase()
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function assetAge(value: string | Date | undefined): string {
  if (!value) return "—"
  const installed = new Date(value)
  const now = new Date()
  let years = now.getFullYear() - installed.getFullYear()
  if (
    now.getMonth() < installed.getMonth() ||
    (now.getMonth() === installed.getMonth() && now.getDate() < installed.getDate())
  ) {
    years -= 1
  }
  return `${Math.max(0, years)} ${years === 1 ? "year" : "years"}`
}

function compactMoney(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value)
}
