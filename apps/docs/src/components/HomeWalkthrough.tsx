"use client"

import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Cable,
  Code2,
  Database,
  GitBranch,
  Layers,
  Pause,
  Play,
  RefreshCw,
  Shapes,
  Wand2,
  Zap,
} from "lucide-react"
import Image from "next/image"
import { useEffect, useId, useRef, useState } from "react"
import { flowSnippets } from "../generated/flowSnippets"
import { homeSnippets } from "../generated/homeSnippets"
import { SourceConstellation } from "./DataFlow"
import { ProjectExplorer } from "./ProjectExplorer"

const nodes = [
  {
    label: "Connectors",
    caption: "APIs, databases & files",
    icon: Cable,
    x: 220,
    y: 125,
    file: "connectors/google-ads.ts",
    title: "Connect to your systems",
    text: "A connector gives your code a client for an external system. Use an existing connector or define your own. A sync uses that client to read data.",
  },
  {
    label: "Syncs",
    caption: "Import data",
    icon: RefreshCw,
    x: 220,
    y: 196,
    file: "syncs/campaigns.ts",
    title: "Bring external data in",
    text: "A sync reads from a connector and writes rows into a dataset. Define what to fetch and where to store it; attach a schedule when it should run regularly.",
  },
  {
    label: "Datasets",
    caption: "Rows in your data lake",
    icon: Database,
    x: 220,
    y: 267,
    file: "datasets/campaigns.ts",
    title: "Give your rows a schema",
    text: "A dataset defines columns and their types. Syncs populate datasets; pipelines transform them; projections map their rows into your object model.",
  },
  {
    label: "Pipelines",
    caption: "Clean & shape · optional",
    icon: Wand2,
    x: 220,
    y: 338,
    file: "pipelines/campaigns.ts",
    title: "Prepare data for your model",
    text: "Compose steps that clean, filter, or reshape a dataset. The pipeline outputs another dataset for your projections. Skip this step when the imported rows are already ready.",
  },
  {
    label: "Ontology",
    caption: "Your shared model",
    icon: Shapes,
    x: 220,
    y: 419,
    file: "ontology/campaign.ts",
    title: "Describe your business once",
    text: "Define object types, their properties, links, and time series. This is your ontology: the shared model that projections populate and your app, agents, and workflows work with.",
  },
  {
    label: "Projections",
    caption: "Index dataset rows",
    icon: Layers,
    x: 220,
    y: 482,
    file: "projections/campaigns.ts",
    title: "Map rows into your model",
    text: "A projection maps dataset columns to object properties or time-series points. The ontology defines their shape; projections turn imported rows into indexed data you can query.",
  },
  {
    label: "Objects",
    caption: "Properties, links & time series",
    icon: Shapes,
    x: 220,
    y: 570,
    file: "ontology/campaign.ts",
    title: "Work with connected objects",
    text: "Objects are instances of your object types. Read their properties, follow their links, query their time series, and access them through the same typed API. Access is governed by the caller’s permissions.",
  },
  {
    label: "Actions",
    caption: "Business commands",
    icon: Zap,
    x: 363,
    y: 570,
    file: "actions/mark-reviewed.ts",
    title: "Define what can be done",
    text: "Actions are typed commands attached to object types. Apps, agents, and workflows can invoke them to change objects or write back to external systems when the integration supports it.",
  },
  {
    label: "Agent",
    caption: "Explore & act",
    icon: Bot,
    x: 77,
    y: 681,
    file: "agent/conversation.ts",
    title: "Ask questions, take action",
    text: "The built-in agent explores the same objects and can run the actions and workflows available to it. Its access stays within the caller’s permissions.",
  },
  {
    label: "App",
    caption: "Your React interface",
    icon: Code2,
    x: 220,
    y: 681,
    file: "app/page.tsx",
    title: "Build on the same data",
    text: "Use typed React hooks to query objects and respond to updates. Your interface can trigger actions and workflows without defining another business model for the browser.",
  },
  {
    label: "Workflows",
    caption: "Multi-step processes",
    icon: GitBranch,
    x: 363,
    y: 681,
    file: "workflows/monthly-report.ts",
    title: "Coordinate a longer process",
    text: "Compose a process from separate steps, including human review or agentic work. Start it from your app or an agent, run it in the background, and track its progress.",
  },
] as const

// A single clock carries one signal to the shared junction, then splits it three ways.
const mainRoute = [
  [220, 65],
  [220, 625],
]
const branchRoutes = [77, 220, 363].map((x) => [
  [220, 625],
  [x, 625],
  [x, 681],
])
const actionRoute = [
  [220, 570],
  [363, 570],
]
function pointOnRoute(points: number[][], progress: number) {
  const lengths = points
    .slice(1)
    .map((p, i) => Math.hypot(p[0]! - points[i]![0]!, p[1]! - points[i]![1]!))
  let distance = lengths.reduce((a, b) => a + b, 0) * Math.min(1, Math.max(0, progress))
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!
    if (distance <= length && length > 0) {
      const a = points[i]!,
        b = points[i + 1]!
      return {
        x: a[0]! + ((b[0]! - a[0]!) * distance) / length,
        y: a[1]! + ((b[1]! - a[1]!) * distance) / length,
      }
    }
    distance -= length
  }
  const last = points[points.length - 1]!
  return { x: last[0]!, y: last[1]! }
}

export function HomeWalkthrough() {
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [visible, setVisible] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(true)
  const [elapsed, setElapsed] = useState(0)
  const clock = useRef(0)
  const root = useRef<HTMLElement>(null)
  const panelId = useId()
  const item = nodes[step] ?? nodes[0]
  const snippet =
    homeSnippets.find((s) => s.path === item.file) ?? flowSnippets.find((s) => s.path === item.file)
  const running = playing && visible && !reducedMotion

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener("change", update)
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(Boolean(entry?.isIntersecting))
    )
    if (root.current) observer.observe(root.current)
    return () => {
      media.removeEventListener("change", update)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!running) return
    let id = 0
    let previous: number | undefined
    const tick = (now: number) => {
      if (previous !== undefined)
        clock.current = (clock.current + Math.min(now - previous, 64) / 1.5) % 19800
      previous = now
      setElapsed(clock.current)
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [running])
  const main = pointOnRoute(mainRoute, elapsed / 9000)
  const reached =
    elapsed < 9000
      ? main.y < 170
        ? 0
        : main.y < 241
          ? 1
          : main.y < 312
            ? 2
            : main.y < 392
              ? 3
              : main.y < 455
                ? 4
                : main.y < 550
                  ? 5
                  : 6
      : -1

  // The same step drives the highlighted node, explanation, and code.
  const animatedStep =
    elapsed >= 10800
      ? Math.min(10, 8 + Math.floor((elapsed - 10800) / 3000))
      : elapsed >= 8800
        ? 7
        : reached
  useEffect(() => {
    if (running) {
      setStep(animatedStep)
    }
  }, [running, animatedStep])

  function selectStep(index: number) {
    setPlaying(false)
    setStep(index)
  }

  return (
    <section className="home-tour" ref={root} data-running={running} aria-label="How Sixb works">
      <div className="tour-intro">
        <h2>What is Sixb?</h2>
        <p>Bring data in. Give it a shared model. Build apps, agents, and processes on top.</p>
      </div>
      <div className="tour-body">
        <div className="tour-visual">
          <div className="primitive-map" aria-label="Select a primitive">
            <div className="primitive-sources" aria-hidden="true">
              <SourceConstellation />
            </div>
            <svg
              className="primitive-wires"
              viewBox="0 0 440 770"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path
                className="primitive-layer-bracket"
                d="M308 165H316Q322 165 322 171V363Q322 369 316 369H308M137 537H131Q125 537 125 543V597Q125 603 131 603H137"
              />
              <path className="tour-wire" d="M220 65V625M77 681V625H363V681M220 625V681" />
              <path className="tour-wire primitive-command-link" d="M220 570H363V625" />
              {!reducedMotion && elapsed < 9000 && (
                <circle className="primitive-light" cx={main.x} cy={main.y} r="3" />
              )}
              {!reducedMotion &&
                elapsed >= 9000 &&
                elapsed < 10800 &&
                branchRoutes.map((route, index) => {
                  const point = pointOnRoute(route, (elapsed - 9000) / 1800)
                  return (
                    <circle
                      key={index}
                      className="primitive-light"
                      cx={point.x}
                      cy={point.y}
                      r="2.2"
                    />
                  )
                })}
              {!reducedMotion &&
                elapsed >= 8100 &&
                elapsed < 9000 &&
                (() => {
                  const point = pointOnRoute(actionRoute, (elapsed - 8100) / 900)
                  return <circle className="primitive-light" cx={point.x} cy={point.y} r="2.2" />
                })()}
            </svg>
            <div className="primitive-layer primitive-layer-lake">
              <strong>Data lake</strong>
              <span>Raw &amp; transformed datasets</span>
            </div>
            <div className="primitive-layer primitive-layer-query">
              <strong>Queryable data</strong>
              <span>Objects, links &amp; time series</span>
              <div className="primitive-provider-logos">
                <span title="PostgreSQL">
                  <Image
                    src="/assets/connectors/postgresql.png"
                    alt="PostgreSQL"
                    width={18}
                    height={18}
                  />
                </span>
                <span title="SQLite">
                  <Image
                    src="/assets/connectors/sqlite-icon.svg"
                    alt="SQLite"
                    unoptimized
                    width={18}
                    height={18}
                  />
                </span>
                <span className="primitive-provider-more" aria-label="…">
                  …
                </span>
              </div>
            </div>
            {nodes.map((node, index) => {
              const Icon = node.icon
              return (
                <button
                  key={node.label}
                  type="button"
                  className={`primitive-node primitive-node-${index}`}
                  style={{ left: `${node.x / 4.4}%`, top: `${node.y / 7.7}%` }}
                  data-lit={step === index}
                  aria-pressed={step === index}
                  aria-controls={panelId}
                  onClick={() => {
                    selectStep(index)
                    if (matchMedia("(max-width: 900px)").matches) {
                      document.getElementById(panelId)?.scrollIntoView({
                        behavior: reducedMotion ? "instant" : "smooth",
                        block: "start",
                      })
                    }
                  }}
                >
                  <span>
                    <Icon size={16} />
                    <strong>{node.label}</strong>
                  </span>
                  <small>{node.caption}</small>
                </button>
              )
            })}
            <span className="primitive-output">output dataset</span>
          </div>
          <button
            className="tour-pause"
            type="button"
            disabled={reducedMotion}
            onClick={() => setPlaying(!playing)}
            aria-label={playing ? "Pause illustration" : "Play illustration"}
          >
            {playing && !reducedMotion ? <Pause size={12} /> : <Play size={12} />}
            {reducedMotion ? "Reduced motion" : playing ? "Pause" : "Play"}
          </button>
        </div>
        <div className="tour-explanation" id={panelId}>
          <div key={step} className="tour-explanation-content">
            <button
              className="tour-back"
              type="button"
              onClick={() =>
                root.current?.querySelector(".tour-visual")?.scrollIntoView({
                  behavior: reducedMotion ? "instant" : "smooth",
                  block: "start",
                })
              }
            >
              <ArrowLeft size={12} /> Back to diagram
            </button>
            <span className="tour-eyebrow">{item.label}</span>
            <h3>{item.title}</h3>
            <p>{item.text}</p>
            {snippet && (
              <div className="flow-code">
                <div className="flow-code-title">
                  <span>{item.file.endsWith("tsx") ? "TSX" : "TS"}</span>
                  <span>{item.file}</span>
                  <span>Example</span>
                </div>
                {/* biome-ignore lint/security/noDangerouslySetInnerHtml: build-time highlighting of repository examples */}
                <div className="prose" dangerouslySetInnerHTML={{ __html: snippet.html }} />
              </div>
            )}
          </div>
          <div className="tour-footer">
            <button
              type="button"
              disabled={step === 0}
              onClick={() => selectStep(step - 1)}
              aria-label="Previous primitive"
            >
              <ArrowLeft size={15} />
            </button>
            <span>
              {step + 1} / {nodes.length} concepts
            </span>
            <button
              type="button"
              disabled={step === nodes.length - 1}
              onClick={() => selectStep(step + 1)}
              aria-label="Next primitive"
            >
              <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </div>
      <section
        id="explore-the-code"
        className="home-code-example"
        aria-labelledby="explore-code-title"
      >
        <h2 id="explore-code-title">Explore the code</h2>
        <p>
          The complete files behind the illustration. Follow a campaign from import to your app,
          then explore actions, agent conversations, and workflow steps.
        </p>
        <ProjectExplorer
          project="data"
          guided
          renderCode={(html) => (
            // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time highlighting of repository examples
            <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
          )}
        />
        <p className="home-code-note">
          These are authoring examples, not a running demo. Live imports need Google Ads
          credentials; agent execution needs a configured language model. The workflow analyzes
          supplied performance and waits for a reviewer.
        </p>
      </section>
    </section>
  )
}
