import { events, listObjectsOptions, useLatestByObject } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { acUnitObjectTypeId, acUnitProps, MODE_NAMES } from "../lib/acUnitConstants"

function modeClass(mode: number): string {
  const map: Record<number, string> = {
    0: "mode-auto",
    1: "mode-dry",
    2: "mode-cool",
    3: "mode-heat",
    4: "mode-fan",
  }
  return map[mode] ?? "mode-auto"
}

function ArrowIcon() {
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" fill="none" className="temp-arrow">
      <path
        d="M1 5h8M7 2.5L9.5 5 7 7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M5.5 3.5L9 7l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function DevicePicker() {
  const objectsQuery = useQuery(
    listObjectsOptions({
      query: {
        objectTypeId: acUnitObjectTypeId,
        limit: "200",
        orderBy: "updatedAt",
        order: "desc",
      },
    })
  )
  const objects = objectsQuery.data ?? []

  const { byObject: liveState, connected } = useLatestByObject(events.telemetry())

  const deviceCount = objects.length
  const sortedObjects = useMemo(() => objects, [objects])

  if (objectsQuery.isLoading) {
    return (
      <div className="page-root page-center">
        <div className="panel-glass loading-panel reveal">
          <p className="eyebrow">Sixb AC Twin</p>
          <p className="loading-title">Discovering AC units...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-root">
      <div className="twin-shell">
        <section className="panel-glass hero-panel reveal">
          <div className="hero-top">
            <div>
              <div className="hero-chip">
                <span
                  className={`status-dot ${connected ? "status-online pulse-live" : "status-offline"}`}
                />
                <span>{connected ? "Live Telemetry" : "Disconnected"}</span>
              </div>
              <h1 className="hero-title">AC Twin Dashboard</h1>
              <p className="hero-subtitle">
                Monitor and control your Panasonic air conditioning units in real time. Select a
                unit to view its thermostat and adjust settings.
              </p>
            </div>
            <div className="count-block">
              <p className="eyebrow">Units</p>
              <p className="count-value">{deviceCount}</p>
            </div>
          </div>
        </section>

        {sortedObjects.length === 0 ? (
          <div className="panel-glass empty-state reveal reveal-1">
            <p className="empty-title">No AC units discovered yet</p>
            <p className="empty-subtitle">
              Units are discovered by pipelines. Wait for the next scan cycle.
            </p>
          </div>
        ) : (
          <div className="device-grid">
            {sortedObjects.map((object, i) => {
              const live = liveState[object.primaryId] ?? {}
              const props = object.properties ?? {}
              const power = live[acUnitProps.power]?.value ?? props[acUnitProps.power]
              const mode = live[acUnitProps.mode]?.value ?? props[acUnitProps.mode]
              const indoor =
                live[acUnitProps.temperatureIndoor]?.value ?? props[acUnitProps.temperatureIndoor]
              const target =
                live[acUnitProps.temperatureTarget]?.value ?? props[acUnitProps.temperatureTarget]
              const eco = live[acUnitProps.eco]?.value ?? props[acUnitProps.eco]
              const nanoe = live[acUnitProps.nanoe]?.value ?? props[acUnitProps.nanoe]

              const isPoweredOn = power === true
              const modeNum = typeof mode === "number" ? mode : 0
              const displayMode = MODE_NAMES[modeNum] ?? "Auto"
              const rawName = props[acUnitProps.name]
              const name = typeof rawName === "string" ? rawName : object.primaryId

              return (
                <a
                  key={object.primaryId}
                  href={`/unit/${encodeURIComponent(object.primaryId)}`}
                  className="ac-card panel-glass reveal"
                  style={{ animationDelay: `${120 + i * 55}ms` }}
                >
                  <div className="card-header">
                    <p className="card-kicker">AC Unit</p>
                    <span
                      className={`status-dot ${isPoweredOn ? "status-online pulse-live" : "status-offline"}`}
                    />
                  </div>
                  <h2 className="card-title">{name}</h2>
                  <div className="card-meta">
                    <span className={`mode-chip ${modeClass(modeNum)}`}>{displayMode}</span>
                    {indoor != null && target != null && (
                      <span className="temp-badge">
                        <span className="temp-current">{Number(indoor).toFixed(1)}°</span>
                        <ArrowIcon />
                        <span className="temp-target">{Number(target).toFixed(1)}°</span>
                      </span>
                    )}
                    {eco === true && <span className="tag-chip">ECO</span>}
                    {nanoe === true && <span className="tag-chip">nanoe</span>}
                  </div>
                  <div className="card-cta">
                    <span>Open Controls</span>
                    <ChevronRight />
                  </div>
                </a>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
