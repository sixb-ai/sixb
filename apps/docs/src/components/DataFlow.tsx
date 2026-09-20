"use client"

import {
  Bot,
  Cable,
  Code2,
  Database,
  File,
  GitBranch,
  Layers,
  Pause,
  Play,
  RefreshCw,
  Shapes,
  Wand2,
} from "lucide-react"
import Image from "next/image"
import { useEffect, useId, useRef, useState } from "react"
import { flowSnippets } from "../generated/flowSnippets"
import { dataFlowFrame, flowStepMs } from "./dataFlowMotion"

const steps = [
  {
    label: "Sources",
    primitive: "Connectors",
    file: "connectors/google-ads.ts",
    detail: "Connect your APIs, databases, and files through reusable connectors.",
    output: "Google Ads · Stripe · your systems",
    href: "/connectors",
  },
  {
    label: "Sync",
    primitive: "Import",
    file: "syncs/campaigns.ts",
    detail: "A sync reads campaign data from Google Ads and writes it into a dataset.",
    output: "External data → dataset",
    href: "/syncs",
  },
  {
    label: "Dataset",
    primitive: "Raw data",
    file: "datasets/campaigns.ts",
    detail:
      "Keep the imported rows in your data lake. The dataset defines their columns and types.",
    output: "google.campaigns",
    href: "/datasets",
  },
  {
    label: "Pipeline",
    primitive: "Clean and shape it (optional)",
    file: "pipelines/campaigns.ts",
    detail:
      "Clean names and select enabled campaigns. The pipeline produces a new dataset; skip it when the source data is already ready.",
    output: "campaigns.clean",
    href: "/pipelines",
  },
  {
    label: "Projection",
    primitive: "Index your data",
    file: "projections/campaigns.ts",
    detail:
      "Map dataset columns to Campaign properties. Your ontology defines the shape those objects must follow.",
    output: "Rows → Campaign objects",
    href: "/projections",
  },
  {
    label: "Objects, properties & links",
    primitive: "Shared data",
    file: "ontology/campaign.ts",
    detail:
      "Your app, agents, and workflows work with the same objects and performance history, within their permissions.",
    output: "Campaign · Account · performance history",
    href: "/ontology",
  },
  {
    label: "App",
    primitive: "React",
    file: "app/page.tsx",
    detail:
      "Build an interface that queries campaigns, reacts to updates, and lets users trigger actions and workflows.",
    output: "Your marketing platform",
    href: "/apps",
  },
  {
    label: "Agent",
    primitive: "AI assistant",
    detail:
      "Let users explore campaign performance in a conversation. An agent can call authorized actions and workflows.",
    output: "Analyze this month’s campaigns",
    href: "/models/built-in-agent",
  },
  {
    label: "Workflows",
    primitive: "Business processes",
    detail:
      "Run multi-step processes on the same data, such as analyzing performance, reviewing a report, and sending it to a client.",
    output: "Analyze → review → send",
    href: "/workflows",
  },
  {
    label: "Ontology",
    primitive: "Shared model",
    file: "ontology/campaign.ts",
    detail:
      "Define what a Campaign is: its properties, its account relationships, and the metrics tracked over time. The projection maps data to this model.",
    output: "Campaign { id, name, status }",
    href: "/ontology",
  },
] as const

const sources = [
  { name: "Google Ads", image: "googleads.svg" },
  { name: "Microsoft", image: "microsoft.ico" },
  { name: "Google", image: "google.ico" },
  { name: "GitHub", image: "github.svg" },
  { name: "Notion", image: "notion.svg" },
  { name: "Stripe", image: "stripe.svg" },
  { name: "Database", icon: Database },
  { name: "File", icon: File },
] as const

export function SourceConstellation() {
  return (
    <div className="flow-constellation">
      <span className="constellation-core">
        <Cable size={16} />
      </span>
      <div className="constellation-orbit">
        {sources.map((source, index) => {
          const tilt = index % 2 === 0 ? -16 : 18
          const radius = 57 + (index % 3) * 4
          const radians = (tilt * Math.PI) / 180
          const dx = Math.cos(radians) * radius
          const dy = Math.sin(radians) * radius
          const orbit = `M ${85 - dx} ${48 - dy} A ${radius} ${27 + (index % 3) * 3} ${tilt} 1 0 ${85 + dx} ${48 + dy} A ${radius} ${27 + (index % 3) * 3} ${tilt} 1 0 ${85 - dx} ${48 - dy}`
          const duration = 38 + (index % 3) * 3
          return (
            <span
              key={source.name}
              className="constellation-position"
              style={{
                offsetPath: `path("${orbit}")`,
                offsetDistance: `${index * 12.5}%`,
                animationDuration: `${duration}s`,
                animationDelay: `${(-duration * index) / sources.length}s`,
              }}
            >
              <span className="constellation-upright">
                <span className="constellation-logo" title={source.name}>
                  {"image" in source ? (
                    <Image
                      unoptimized
                      src={`/assets/connectors/${source.image}`}
                      alt=""
                      width={17}
                      height={17}
                    />
                  ) : (
                    <source.icon size={16} />
                  )}
                </span>
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function DataFlow() {
  const [selected, setSelected] = useState(0)
  const [ontologyActive, setOntologyActive] = useState(false)
  const ontologyArrival = useRef(false)
  const [branchesArrived, setBranchesArrived] = useState(false)
  const branchArrival = useRef(false)
  const branchWires = useRef<SVGSVGElement>(null)
  const [inspecting, setInspecting] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [reducedMotion, setReducedMotion] = useState(true)
  const [visible, setVisible] = useState(false)
  const container = useRef<HTMLElement>(null)
  const detailPanel = useRef<HTMLElement>(null)
  const light = useRef<HTMLSpanElement>(null)
  const elapsed = useRef(0)
  const activeStage = useRef(0)
  const panelId = useId()
  const step = steps[selected] ?? steps[0]
  const snippetPath =
    "file" in step
      ? step.file
      : selected === 7
        ? "agent/conversation.ts"
        : "workflows/monthly-report.ts"
  const snippet = flowSnippets.find((item) => item.path === snippetPath)
  const running = playing && !reducedMotion && visible && !inspecting

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener("change", update)
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.2 }
    )
    if (container.current) observer.observe(container.current)
    return () => {
      media.removeEventListener("change", update)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!running) return
    const paths = Array.from(branchWires.current?.querySelectorAll("path") ?? [])
    const dots = Array.from(branchWires.current?.querySelectorAll("circle") ?? [])
    const lengths = paths.map((path) => path.getTotalLength())
    let frameId = 0
    let previous = performance.now()
    const tick = (now: number) => {
      elapsed.current += Math.min(now - previous, 100)
      previous = now
      const frame = dataFlowFrame(elapsed.current)
      if (light.current) {
        light.current.style.top = `${frame.position}%`
        light.current.style.opacity = frame.travelling ? "1" : "0"
      }
      dots.forEach((dot, index) => {
        const point = paths[index]?.getPointAtLength((lengths[index] ?? 0) * frame.branchProgress)
        if (point) {
          dot.setAttribute("cx", String(point.x))
          dot.setAttribute("cy", String(point.y))
        }
        dot.style.opacity = frame.branching ? "1" : "0"
      })
      if (frame.branchesArrived !== branchArrival.current) {
        branchArrival.current = frame.branchesArrived
        setBranchesArrived(frame.branchesArrived)
      }
      if (frame.ontologyActive !== ontologyArrival.current) {
        ontologyArrival.current = frame.ontologyActive
        setOntologyActive(frame.ontologyActive)
      }
      if (frame.stage !== activeStage.current) {
        activeStage.current = frame.stage
        setSelected(frame.stage)
      }
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [running])

  // biome-ignore lint/correctness/useExhaustiveDependencies: Each new selection resets the reading position.
  useEffect(() => {
    if (detailPanel.current) detailPanel.current.scrollTop = 0
  }, [selected])

  function select(index: number) {
    elapsed.current = Math.min(index, 5) * flowStepMs
    activeStage.current = Math.min(index, 5)
    if (light.current) light.current.style.opacity = "0"
    setSelected(index)
    branchArrival.current = index >= 6 && index <= 8
    setBranchesArrived(branchArrival.current)
    branchWires.current?.querySelectorAll("circle").forEach((dot) => {
      dot.style.opacity = "0"
    })
    ontologyArrival.current = index === 4 || index === 9
    setOntologyActive(ontologyArrival.current)
    setPlaying(false)
    if (window.matchMedia("(max-width: 600px)").matches) {
      detailPanel.current?.scrollIntoView({
        behavior: reducedMotion ? "instant" : "smooth",
        block: "start",
      })
    }
  }

  return (
    <section
      ref={container}
      className="data-flow"
      data-running={running}
      aria-label="Explore the data flow"
    >
      <div className="flow-layout">
        <div className="flow-diagram">
          <div className="flow-caption">
            <button
              type="button"
              onClick={() => setPlaying(!playing)}
              disabled={reducedMotion}
              aria-label={playing && !reducedMotion ? "Pause animation" : "Play animation"}
            >
              {playing && !reducedMotion ? <Pause size={13} /> : <Play size={13} />}
              <span>{reducedMotion ? "Reduced motion" : playing ? "Pause" : "Play"}</span>
            </button>
          </div>
          <div className="flow-scene">
            <div className="flow-track" aria-hidden="true">
              <span className="flow-line" />
              <span ref={light} className="flow-light" />
            </div>
            {steps.slice(0, 6).map((item, index) => {
              const Icon = [Cable, RefreshCw, Database, Wand2, Layers, Shapes][index] ?? Shapes
              return (
                <div className="flow-row" key={item.label}>
                  <button
                    type="button"
                    className="flow-stage"
                    aria-pressed={selected === index}
                    aria-controls={panelId}
                    onClick={() => select(index)}
                  >
                    <span className="flow-illustration" aria-hidden="true">
                      <span
                        key={selected === index ? `arrival-${index}` : "idle"}
                        className="flow-arrival"
                      />
                      {index === 0 ? <SourceConstellation /> : <Icon size={21} strokeWidth={1.4} />}
                    </span>
                    <span className="flow-label">
                      <strong>{item.label}</strong>
                      <span className="flow-primitive">{item.primitive}</span>
                    </span>
                  </button>
                  {index === 4 && (
                    <div className="flow-hat" data-active={ontologyActive}>
                      <button
                        type="button"
                        className="flow-ontology"
                        aria-pressed={selected === 9}
                        aria-controls={panelId}
                        onClick={() => select(9)}
                      >
                        <svg
                          key={ontologyActive ? "active" : "idle"}
                          className="flow-hat-shape"
                          viewBox="0 0 140 70"
                          aria-hidden="true"
                        >
                          <path d="M8 60V30Q8 8 32 8H108Q132 8 132 30V60H106V50Q106 32 88 32H52Q34 32 34 50V60Z" />
                        </svg>
                        <strong>Ontology</strong>
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="flow-branches" data-active={branchesArrived}>
            <svg
              ref={branchWires}
              className="flow-branch-wires"
              viewBox="0 0 240 36"
              aria-hidden="true"
            >
              <path d="M120 0H48Q40 0 40 8V36" />
              <path d="M120 0V36" />
              <path d="M120 0H192Q200 0 200 8V36" />
              {[0, 1, 2].map((index) => (
                <circle key={index} cx="120" cy="0" r="2.5" />
              ))}
            </svg>
            {([7, 6, 8] as const).map((index) => {
              const item = steps[index]
              const Icon = index === 6 ? Code2 : index === 7 ? Bot : GitBranch
              return (
                <button
                  type="button"
                  key={item.label}
                  aria-pressed={selected === index}
                  aria-controls={panelId}
                  onClick={() => select(index)}
                >
                  <Icon size={23} strokeWidth={1.4} />
                  <strong>{item.label}</strong>
                </button>
              )
            })}
          </div>
        </div>
        <aside
          ref={detailPanel}
          className="flow-detail-panel"
          id={panelId}
          aria-label={`${step.label} explanation and code`}
          onMouseEnter={() => setInspecting(true)}
          onMouseLeave={() => setInspecting(false)}
          onFocus={() => setInspecting(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setInspecting(false)
          }}
        >
          <button
            type="button"
            className="flow-back"
            onClick={() =>
              container.current?.scrollIntoView({
                behavior: reducedMotion ? "instant" : "smooth",
                block: "start",
              })
            }
          >
            ↑ Back to diagram
          </button>
          <div key={selected} className="flow-detail-content">
            <span className="flow-step-count">{step.primitive}</span>
            <h3>{step.label}</h3>
            <p>{step.detail}</p>
            {snippet && (
              <div className="flow-code">
                <div className="flow-code-title">
                  <span>{snippet.path.endsWith("tsx") ? "TSX" : "TS"}</span>
                  <span>{snippet.path}</span>
                </div>
                {/* Build-time highlighting of trusted repository examples. */}
                {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted build-time snippets */}
                <div className="prose" dangerouslySetInnerHTML={{ __html: snippet.html }} />
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  )
}
