import { encodeObjectId } from "@sixb/client"
import { events, getObjectOptions, requestActionMutation, useLatest } from "@sixb/client/hooks"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { useParams } from "react-router-dom"
import {
  acUnitObjectTypeId,
  acUnitProps,
  FAN_SPEED_NAMES,
  MODE_NAMES,
} from "../../../lib/acUnitConstants"
import { PanasonicAcUnit } from "../../../ontology/acUnit"

function decodeKey(input: string | undefined): string | null {
  if (!input) return null
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function modeColorClass(mode: number): string {
  const map: Record<number, string> = {
    0: "mode-auto",
    1: "mode-dry",
    2: "mode-cool",
    3: "mode-heat",
    4: "mode-fan",
  }
  return map[mode] ?? "mode-auto"
}

/* ── Thermostat Gauge ── */

function ThermostatGauge({
  indoor,
  outdoor,
  target,
  mode,
}: {
  indoor: number | null
  outdoor: number | null
  target: number | null
  mode: number
}) {
  const size = 300
  const cx = size / 2
  const cy = size / 2
  const r = 110

  const startAngle = 135
  const endAngle = 405
  const sweep = endAngle - startAngle
  const minTemp = 10
  const maxTemp = 35
  const range = maxTemp - minTemp

  function tempToAngle(temp: number): number {
    const clamped = Math.max(minTemp, Math.min(maxTemp, temp))
    return startAngle + ((clamped - minTemp) / range) * sweep
  }

  function polarXY(angle: number, radius: number) {
    const rad = ((angle - 90) * Math.PI) / 180
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) }
  }

  const arcStart = polarXY(startAngle, r)
  const arcEnd = polarXY(endAngle, r)
  const arcPath = `M ${arcStart.x} ${arcStart.y} A ${r} ${r} 0 1 1 ${arcEnd.x} ${arcEnd.y}`

  const arcLength = 2 * Math.PI * r * (sweep / 360)
  const targetRatio =
    target != null ? (Math.max(minTemp, Math.min(maxTemp, target)) - minTemp) / range : 0
  const filledLength = arcLength * targetRatio

  const targetPos = target != null ? polarXY(tempToAngle(target), r) : null
  const indoorPos = indoor != null ? polarXY(tempToAngle(indoor), r) : null

  const modeColors: Record<number, [string, string]> = {
    0: ["#54b474", "#3a9060"],
    1: ["#bca048", "#9a8038"],
    2: ["#5090cc", "#3070aa"],
    3: ["#cc6e42", "#aa5030"],
    4: ["#7585a0", "#5868a0"],
  }
  const [color1, color2] = modeColors[mode] ?? modeColors[0]

  const ticks = []
  for (let t = minTemp; t <= maxTemp; t++) {
    const angle = tempToAngle(t)
    const isMajor = t % 5 === 0
    const inner = polarXY(angle, r + 7)
    const outer = polarXY(angle, r + (isMajor ? 19 : 13))
    ticks.push({ t, isMajor, inner, outer, angle })
  }

  let statusText = ""
  if (indoor != null && target != null) {
    const diff = indoor - target
    if (mode === 2) statusText = diff > 0.5 ? "Cooling" : "At target"
    else if (mode === 3) statusText = diff < -0.5 ? "Heating" : "At target"
    else if (mode === 0)
      statusText = Math.abs(diff) < 0.5 ? "At target" : diff > 0 ? "Cooling" : "Heating"
  }

  return (
    <svg viewBox={`0 0 ${size} ${size}`} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="arcGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={color1} />
          <stop offset="100%" stopColor={color2} />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Tick marks */}
      {ticks.map(({ t, isMajor, inner, outer }) => (
        <line
          key={t}
          x1={inner.x}
          y1={inner.y}
          x2={outer.x}
          y2={outer.y}
          stroke={isMajor ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)"}
          strokeWidth={isMajor ? 1.8 : 1}
          strokeLinecap="round"
        />
      ))}

      {/* Major tick labels */}
      {ticks
        .filter((t) => t.isMajor)
        .map(({ t }) => {
          const labelPos = polarXY(tempToAngle(t), r + 30)
          return (
            <text
              key={`label-${t}`}
              x={labelPos.x}
              y={labelPos.y}
              textAnchor="middle"
              dominantBaseline="central"
              fill="rgba(255,255,255,0.16)"
              fontSize="9"
              fontFamily="Sora, sans-serif"
              fontWeight="500"
            >
              {t}°
            </text>
          )
        })}

      {/* Background arc */}
      <path
        d={arcPath}
        fill="none"
        stroke="rgba(255,255,255,0.035)"
        strokeWidth="10"
        strokeLinecap="round"
      />

      {/* Filled arc up to target */}
      {target != null && (
        <path
          d={arcPath}
          fill="none"
          stroke="url(#arcGrad)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${filledLength} ${arcLength}`}
          opacity="0.7"
          style={{
            transition: "stroke-dasharray 400ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />
      )}

      {/* Indoor marker */}
      {indoorPos && (
        <circle
          cx={indoorPos.x}
          cy={indoorPos.y}
          r="4.5"
          fill="#fff"
          stroke="rgba(0,0,0,0.25)"
          strokeWidth="1.2"
          opacity="0.6"
        />
      )}

      {/* Target marker with glow */}
      {targetPos && (
        <g filter="url(#glow)">
          <circle
            cx={targetPos.x}
            cy={targetPos.y}
            r="8"
            fill={color1}
            stroke="#fff"
            strokeWidth="2.5"
          />
        </g>
      )}

      {/* Center: indoor small */}
      {indoor != null && (
        <text
          x={cx}
          y={cy - 30}
          textAnchor="middle"
          fill="rgba(255,255,255,0.35)"
          fontSize="12"
          fontFamily="Sora, sans-serif"
          fontWeight="500"
        >
          {indoor.toFixed(1)}° indoor
        </text>
      )}

      {/* Center: target large */}
      <text
        x={cx}
        y={cy + 12}
        textAnchor="middle"
        fill="#ece8e0"
        fontSize="38"
        fontFamily="DM Mono, monospace"
        fontWeight="500"
      >
        {target != null ? `${target.toFixed(1)}°` : "\u2014"}
      </text>

      {/* Center: "TARGET" label */}
      <text
        x={cx}
        y={cy + 30}
        textAnchor="middle"
        fill="rgba(255,255,255,0.2)"
        fontSize="9"
        fontFamily="Sora, sans-serif"
        fontWeight="600"
        letterSpacing="0.18em"
      >
        TARGET
      </text>

      {/* Status text */}
      {statusText && (
        <text
          x={cx}
          y={cy + 48}
          textAnchor="middle"
          fill={color1}
          fontSize="10"
          fontFamily="Sora, sans-serif"
          fontWeight="500"
          opacity="0.65"
        >
          {statusText}
        </text>
      )}

      {/* Outdoor temp */}
      {outdoor != null && (
        <text
          x={cx}
          y={cy + (statusText ? 66 : 52)}
          textAnchor="middle"
          fill="rgba(255,255,255,0.18)"
          fontSize="11"
          fontFamily="Sora, sans-serif"
          fontWeight="400"
        >
          {outdoor.toFixed(1)}° outdoor
        </text>
      )}
    </svg>
  )
}

/* ── Toggle ── */

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`toggle ${on ? "is-on" : ""}`} onClick={onToggle}>
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span>{label}</span>
    </button>
  )
}

/* ── Back Arrow Icon ── */

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M10 3L5.5 8l4.5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/* ── Main Page ── */

export default function UnitDetail() {
  const { key: rawKey } = useParams<{ key: string }>()
  const objectKey = decodeKey(rawKey)

  const objectId = objectKey ? encodeObjectId(acUnitObjectTypeId, objectKey) : ""
  const objectQuery = useQuery({
    ...getObjectOptions({
      path: { objectId },
    }),
    enabled: !!objectKey,
  })
  const object = objectQuery.data

  const { values: liveState, connected } = useLatest(
    events(PanasonicAcUnit)
      .object(objectKey ?? "")
      .telemetry()
  )
  const { mutate: sendAction } = useMutation(requestActionMutation())

  function val(propId: string): unknown {
    return liveState[propId]?.value ?? object?.properties[propId]
  }

  const power = val(acUnitProps.power) === true
  const mode = typeof val(acUnitProps.mode) === "number" ? (val(acUnitProps.mode) as number) : 0
  const modeName = MODE_NAMES[mode] ?? "Auto"
  const indoor =
    typeof val(acUnitProps.temperatureIndoor) === "number"
      ? (val(acUnitProps.temperatureIndoor) as number)
      : null
  const outdoor =
    typeof val(acUnitProps.temperatureOutdoor) === "number"
      ? (val(acUnitProps.temperatureOutdoor) as number)
      : null
  const target =
    typeof val(acUnitProps.temperatureTarget) === "number"
      ? (val(acUnitProps.temperatureTarget) as number)
      : null
  const fanSpeed =
    typeof val(acUnitProps.fanSpeed) === "number" ? (val(acUnitProps.fanSpeed) as number) : 0
  const eco = val(acUnitProps.eco) === true
  const nanoe = val(acUnitProps.nanoe) === true
  const econavi = val(acUnitProps.econavi) === true
  const iauto = val(acUnitProps.iauto) === true

  const title = useMemo(() => {
    const raw = object?.properties[acUnitProps.name]
    return (typeof raw === "string" ? raw : null) ?? objectKey ?? "AC Unit"
  }, [objectKey, object?.properties])

  function doAction(actionId: string, params: Record<string, unknown>) {
    if (!objectKey) return
    sendAction({
      path: { actionId },
      body: {
        subject: {
          kind: "object",
          objectTypeId: acUnitObjectTypeId,
          primaryId: objectKey,
        },
        params,
      },
    })
  }

  return (
    <div className="page-root">
      <div className="twin-shell">
        <header className="panel-glass remote-header reveal">
          <div className="remote-header-row">
            <a href="/" className="back-link">
              <BackArrow />
              <span>Dashboard</span>
            </a>
            <div className="hero-chip">
              <span
                className={`status-dot ${connected ? "status-online pulse-live" : "status-offline"}`}
              />
              <span>{connected ? "Live" : "Offline"}</span>
            </div>
          </div>
        </header>

        <div className="detail-layout">
          {/* ── Left: Telemetry Panel ── */}
          <section className="panel-glass telemetry-panel reveal reveal-1">
            <p className="eyebrow">AC Unit Twin</p>
            <h1 className="telemetry-title">{title}</h1>

            <div className="telemetry-grid">
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Power</p>
                <p className={`telemetry-value ${power ? "is-ok" : "is-warn"}`}>
                  {power ? "On" : "Standby"}
                </p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Mode</p>
                <p className="telemetry-value">
                  <span className={`mode-chip ${modeColorClass(mode)}`}>{modeName}</span>
                </p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Indoor</p>
                <p className="telemetry-value">
                  <span className="mono">
                    {indoor != null ? `${indoor.toFixed(1)}°C` : "\u2014"}
                  </span>
                </p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Outdoor</p>
                <p className="telemetry-value">
                  <span className="mono">
                    {outdoor != null ? `${outdoor.toFixed(1)}°C` : "\u2014"}
                  </span>
                </p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Target</p>
                <p className="telemetry-value">
                  <span className="mono">
                    {target != null ? `${target.toFixed(1)}°C` : "\u2014"}
                  </span>
                </p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Fan Speed</p>
                <p className="telemetry-value">{FAN_SPEED_NAMES[fanSpeed] ?? String(fanSpeed)}</p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">ECO</p>
                <p className={`telemetry-value ${eco ? "is-ok" : ""}`}>{eco ? "On" : "Off"}</p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">nanoe</p>
                <p className={`telemetry-value ${nanoe ? "is-ok" : ""}`}>{nanoe ? "On" : "Off"}</p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">Econavi</p>
                <p className={`telemetry-value ${econavi ? "is-ok" : ""}`}>
                  {econavi ? "On" : "Off"}
                </p>
              </div>
              <div className="panel-glass telemetry-card">
                <p className="telemetry-label">iAuto</p>
                <p className={`telemetry-value ${iauto ? "is-ok" : ""}`}>{iauto ? "On" : "Off"}</p>
              </div>
            </div>
          </section>

          {/* ── Right: Thermostat + Controls ── */}
          <div className="reveal reveal-2">
            <section className="panel-glass controls-panel" style={{ marginBottom: "0.9rem" }}>
              <div className="thermostat">
                <ThermostatGauge indoor={indoor} outdoor={outdoor} target={target} mode={mode} />
              </div>

              <div className="control-section">
                <p className="control-section-title">Temperature</p>
                <div className="temp-control" style={{ justifyContent: "center" }}>
                  <button
                    type="button"
                    className="control-btn"
                    onClick={() =>
                      target != null && doAction("setTemperature", { value: target - 0.5 })
                    }
                  >
                    -
                  </button>
                  <span className="temp-control-value">
                    {target != null ? `${target.toFixed(1)}°` : "\u2014"}
                  </span>
                  <button
                    type="button"
                    className="control-btn"
                    onClick={() =>
                      target != null && doAction("setTemperature", { value: target + 0.5 })
                    }
                  >
                    +
                  </button>
                </div>
              </div>
            </section>

            <section className="panel-glass controls-panel">
              <div className="control-section">
                <p className="control-section-title">Mode</p>
                <div className="control-row">
                  {Object.entries(MODE_NAMES).map(([code, name]) => (
                    <button
                      key={code}
                      type="button"
                      className={`control-btn ${mode === Number(code) ? "active" : ""}`}
                      onClick={() => doAction("setMode", { mode: Number(code) })}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="control-section">
                <p className="control-section-title">Fan Speed</p>
                <div className="control-row">
                  {Object.entries(FAN_SPEED_NAMES).map(([code, name]) => (
                    <button
                      key={code}
                      type="button"
                      className={`control-btn ${fanSpeed === Number(code) ? "active" : ""}`}
                      onClick={() => doAction("setFan", { speed: Number(code) })}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>

              <hr className="divider" />

              <div className="control-section">
                <p className="control-section-title">Switches</p>
                <div style={{ display: "grid", gap: "0.5rem" }}>
                  <div style={{ display: "flex", gap: "1.5rem", alignItems: "center" }}>
                    <button
                      type="button"
                      className={`control-btn ${power ? "power-on" : "power-off"}`}
                      onClick={() => doAction("setPower", { on: !power })}
                      style={{ minWidth: "5.5rem" }}
                    >
                      {power ? "Power On" : "Power Off"}
                    </button>
                  </div>
                  <Toggle
                    label="ECO"
                    on={eco}
                    onToggle={() => doAction("setEco", { enabled: !eco })}
                  />
                  <Toggle
                    label="nanoe"
                    on={nanoe}
                    onToggle={() => doAction("setNanoe", { enabled: !nanoe })}
                  />
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
