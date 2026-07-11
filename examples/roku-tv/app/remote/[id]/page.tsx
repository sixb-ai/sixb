import {
  events,
  getObjectOptions,
  getObjectTypeOptions,
  useActionRunMutation,
  useLatest,
} from "@sixb/client/hooks"
import { encodeObjectId } from "@sixb/client/models"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { televisionObjectTypeId, televisionTwinProps } from "../../../lib/televisionTwin"
import { Television } from "../../../ontology/television"

const KEYS = {
  dpad: ["Up", "Down", "Left", "Right", "Select"],
  nav: ["Back", "Home", "Info"],
  media: ["Rev", "Play", "Fwd"],
  volume: ["VolumeUp", "VolumeDown", "VolumeMute"],
  power: ["Power", "PowerOff"],
} as const

type RokuKey = (typeof KEYS)[keyof typeof KEYS][number]

const KEY_LABELS: Partial<Record<RokuKey, string>> = {
  Back: "Back",
  Home: "Home",
  Info: "Info",
  Up: "^",
  Down: "v",
  Left: "<",
  Right: ">",
  Select: "OK",
  Rev: "<<",
  Play: "Play",
  Fwd: ">>",
  VolumeUp: "Vol+",
  VolumeDown: "Vol-",
  VolumeMute: "Mute",
  Power: "Power",
  PowerOff: "Off",
}

const APP_SHORTCUTS = ["Netflix", "Prime", "Hulu", "Disney+"] as const
const noop = () => undefined

function RemoteButton({
  label,
  onClick,
  variant = "default",
  active = false,
  loading = false,
  disabled = false,
}: {
  label: string
  onClick: () => void
  variant?: "default" | "power" | "small" | "ok" | "shortcut"
  active?: boolean
  loading?: boolean
  disabled?: boolean
}) {
  const baseClasses = `remote-btn${active ? " is-active" : ""}${loading ? " is-loading" : ""}`
  const variants = {
    default: "",
    power: " power",
    small: " slim",
    ok: " ok",
    shortcut: " shortcut",
  }

  return (
    <button
      type="button"
      className={`${baseClasses}${variants[variant]}`}
      onClick={onClick}
      disabled={disabled}
      aria-busy={loading}
    >
      <span className="remote-btn-label">{label}</span>
      {loading ? <span className="remote-btn-spinner" aria-hidden="true" /> : null}
    </button>
  )
}

function decodeKey(input: string | undefined): string | null {
  if (!input) {
    return null
  }

  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

export default function RemoteControl() {
  const { id } = useParams<{ id: string }>()
  const objectKey = decodeKey(id)

  const objectId = objectKey ? encodeObjectId(televisionObjectTypeId, objectKey) : ""
  const objectQuery = useQuery({
    ...getObjectOptions({
      path: {
        objectId,
      },
    }),
    enabled: !!objectKey,
  })
  const object = objectQuery.data

  const objectTypeQuery = useQuery(
    getObjectTypeOptions({
      path: {
        objectTypeId: televisionObjectTypeId,
      },
    })
  )

  const { values: liveState, connected } = useLatest(events.telemetry().byId(objectKey ?? ""))

  const { mutateAsync: sendAction } = useActionRunMutation<{
    button: RokuKey
  }>({
    actionId: "pressButton",
    subject: objectKey ? { objectType: Television, primaryId: objectKey } : undefined,
    invalidateOnCommit: true,
  })
  const [pendingByKey, setPendingByKey] = useState<Partial<Record<RokuKey, number>>>({})

  const incrementPending = useCallback((key: RokuKey) => {
    setPendingByKey((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }))
  }, [])

  const decrementPending = useCallback((key: RokuKey) => {
    setPendingByKey((current) => {
      const nextCount = (current[key] ?? 0) - 1
      const next = { ...current }
      if (nextCount > 0) {
        next[key] = nextCount
      } else {
        delete next[key]
      }
      return next
    })
  }, [])

  const pressKey = useCallback(
    (key: RokuKey) => {
      if (!objectKey) {
        return
      }

      incrementPending(key)
      void sendAction({ button: key })
        .catch((error) => {
          console.error(
            `[Sixb] Roku action ${key} failed:`,
            error instanceof Error ? error.message : String(error)
          )
        })
        .finally(() => {
          decrementPending(key)
        })
    },
    [decrementPending, incrementPending, objectKey, sendAction]
  )

  const powerState =
    liveState[televisionTwinProps.powerState]?.value ??
    object?.properties[televisionTwinProps.powerState]
  const activeApp =
    liveState[televisionTwinProps.activeApp]?.value ??
    object?.properties[televisionTwinProps.activeApp]
  const mediaState =
    liveState[televisionTwinProps.mediaState]?.value ??
    object?.properties[televisionTwinProps.mediaState]
  const availableActions = objectTypeQuery.data?.actions?.map((a) => a.id) ?? []
  const isPoweredOn = powerState === "PowerOn"
  const powerButtonKey: RokuKey = isPoweredOn ? "PowerOff" : "Power"
  const pendingEntries = (Object.entries(pendingByKey) as [RokuKey, number][]).filter(
    ([, count]) => count > 0
  )
  const pendingCount = pendingEntries.reduce((total, [, count]) => total + count, 0)
  const pendingLabel =
    pendingEntries.length === 1
      ? `${KEY_LABELS[pendingEntries[0][0]] ?? pendingEntries[0][0]}${
          pendingEntries[0][1] > 1 ? ` x${pendingEntries[0][1]}` : ""
        }`
      : pendingCount > 0
        ? `${pendingCount} pending`
        : null
  const powerActionPending = (pendingByKey.Power ?? 0) > 0 || (pendingByKey.PowerOff ?? 0) > 0
  const keyIsPending = (key: RokuKey) => (pendingByKey[key] ?? 0) > 0

  const title = useMemo(() => {
    return asString(object?.properties[televisionTwinProps.name]) ?? objectKey ?? "Television"
  }, [objectKey, object?.properties])

  return (
    <div className="page-root">
      <div className="twin-shell">
        <header className="panel-glass remote-header fade-slide">
          <div className="remote-header-row">
            <Link to="/" className="back-link">
              {"<- Back to twins"}
            </Link>
            <div className="hero-chip">
              <span
                className={`status-dot ${connected ? "status-online pulse-live" : "status-offline"}`}
              />
              <span>{connected ? "Realtime Telemetry Link" : "Telemetry Link Offline"}</span>
            </div>
          </div>
        </header>

        <div className="remote-layout">
          <section className="panel-glass telemetry-panel fade-slide stagger-1">
            <p className="eyebrow">Twin Telemetry</p>
            <h1 className="telemetry-title">{title}</h1>
            <div className="telemetry-grid">
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Power</p>
                <p
                  className={`telemetry-value ${isPoweredOn ? "is-ok" : "is-warn"}${
                    powerActionPending ? " is-pending" : ""
                  }`}
                >
                  {isPoweredOn ? "On" : "Standby"}
                </p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Active App</p>
                <p className="telemetry-value">{activeApp ? String(activeApp) : "Idle"}</p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Media State</p>
                <p className="telemetry-value">{mediaState ? String(mediaState) : "None"}</p>
              </div>
            </div>
            <div className="telemetry-footnote">
              Actions: {availableActions.join(", ") || "(none)"}
            </div>
            {pendingLabel ? (
              <div className="action-pending-row" role="status">
                <span className="action-pending-spinner" aria-hidden="true" />
                <span>{pendingLabel}</span>
              </div>
            ) : null}
          </section>

          <section className="device-remote fade-slide stagger-2">
            <div className="remote-side-controls" aria-hidden="true">
              <div className="side-key" />
              <div className="side-key small" />
            </div>
            <div className="remote-ir-window" aria-hidden="true" />
            <div className="remote-speaker" aria-hidden="true" />
            <div className="remote-meta">
              <h1>{title}</h1>
              <p>{televisionObjectTypeId}</p>
            </div>

            <div className="remote-row">
              <RemoteButton
                label={KEY_LABELS[powerButtonKey] ?? powerButtonKey}
                onClick={() => pressKey(powerButtonKey)}
                variant="power"
                active={powerActionPending}
                loading={powerActionPending}
                disabled={!objectKey || powerActionPending}
              />
              <RemoteButton
                label={KEY_LABELS.Home ?? "Home"}
                onClick={() => pressKey("Home")}
                active={keyIsPending("Home")}
                loading={keyIsPending("Home")}
                disabled={!objectKey}
              />
            </div>

            <div className="dpad">
              <div />
              <RemoteButton
                label={KEY_LABELS.Up ?? "Up"}
                onClick={() => pressKey("Up")}
                active={keyIsPending("Up")}
                loading={keyIsPending("Up")}
                disabled={!objectKey}
              />
              <div />
              <RemoteButton
                label={KEY_LABELS.Left ?? "Left"}
                onClick={() => pressKey("Left")}
                active={keyIsPending("Left")}
                loading={keyIsPending("Left")}
                disabled={!objectKey}
              />
              <RemoteButton
                label={KEY_LABELS.Select ?? "OK"}
                onClick={() => pressKey("Select")}
                variant="ok"
                active={keyIsPending("Select")}
                loading={keyIsPending("Select")}
                disabled={!objectKey}
              />
              <RemoteButton
                label={KEY_LABELS.Right ?? "Right"}
                onClick={() => pressKey("Right")}
                active={keyIsPending("Right")}
                loading={keyIsPending("Right")}
                disabled={!objectKey}
              />
              <div />
              <RemoteButton
                label={KEY_LABELS.Down ?? "Down"}
                onClick={() => pressKey("Down")}
                active={keyIsPending("Down")}
                loading={keyIsPending("Down")}
                disabled={!objectKey}
              />
              <div />
            </div>

            <div className="remote-row">
              {KEYS.nav.map((key) => (
                <RemoteButton
                  key={key}
                  label={KEY_LABELS[key] ?? key}
                  onClick={() => pressKey(key)}
                  variant="small"
                  active={keyIsPending(key)}
                  loading={keyIsPending(key)}
                  disabled={!objectKey}
                />
              ))}
            </div>

            <div className="remote-row">
              {KEYS.media.map((key) => (
                <RemoteButton
                  key={key}
                  label={KEY_LABELS[key] ?? key}
                  onClick={() => pressKey(key)}
                  active={keyIsPending(key)}
                  loading={keyIsPending(key)}
                  disabled={!objectKey}
                />
              ))}
            </div>

            <div className="remote-row">
              {KEYS.volume.map((key) => (
                <RemoteButton
                  key={key}
                  label={KEY_LABELS[key] ?? key}
                  onClick={() => pressKey(key)}
                  variant="small"
                  active={keyIsPending(key)}
                  loading={keyIsPending(key)}
                  disabled={!objectKey}
                />
              ))}
            </div>

            <div className="remote-brand" aria-hidden="true">
              roku
            </div>

            <div className="remote-row shortcuts-row">
              {APP_SHORTCUTS.map((shortcut) => (
                <RemoteButton
                  key={shortcut}
                  label={shortcut}
                  onClick={noop}
                  variant="shortcut"
                  disabled
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
