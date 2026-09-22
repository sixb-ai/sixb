"use client"

import { ArrowDown, ArrowRight, ArrowUpRight, Check, Copy, RotateCcw } from "lucide-react"
import Link from "next/link"
import { useRef, useState } from "react"
import { BuildWithAI } from "./BuildWithAI"
import { FrameworkStack } from "./FrameworkStack"
import { FrameworkStory, type FrameworkStoryHandle } from "./FrameworkStory"
import { useClipboard } from "./useClipboard"
import { useStackScenario } from "./useStackScenario"
import "./homeWalkthrough.css"

const createCommand = "bun create sixb my-app"

const layers = [
  {
    id: "build",
    name: "Build",
    caption: "Put that model to work",
    top: 19.5,
  },
  {
    id: "model",
    name: "Model",
    caption: "Define objects, relationships, and actions",
    top: 45.4,
  },
  {
    id: "prepare",
    name: "Prepare",
    caption: "Shape data for your model",
    top: 67.3,
  },
  {
    id: "connect",
    name: "Connect",
    caption: "Bring your existing systems together",
    top: 88,
  },
] as const

export type StackLayer = (typeof layers)[number]["id"]

export function HomeWalkthrough() {
  const [hovered, setHovered] = useState<StackLayer | null>(null)
  const scenario = useStackScenario()
  const [quoteFocused, setQuoteFocused] = useState(false)
  const created = scenario.phase === "created"
  const pending = scenario.phase === "publishing"
  const ready = scenario.phase === "ready"
  const story = useRef<FrameworkStoryHandle>(null)
  const { status: copyStatus, copy: copyCommand } = useClipboard(createCommand)

  function showExample() {
    story.current?.goTo("connect")
  }

  function selectLayer(item: (typeof layers)[number]) {
    story.current?.goTo(item.id === "build" ? "operate" : item.id)
  }

  function showAction() {
    story.current?.goTo("automate")
  }

  return (
    <div className="framework-home">
      <section className="framework-hero" aria-labelledby="framework-title">
        <div className="framework-intro">
          <h1 id="framework-title">
            <span>Model your domain.</span>
            <span>Put it to work.</span>
          </h1>
          <p className="framework-summary">
            A TypeScript framework for <span>ontology-powered apps and AI.</span>
          </p>
          <div className="framework-starting-point">
            <div className="framework-intro-links">
              <Link className="framework-start" href="/get-started">
                Get Started <ArrowRight size={15} aria-hidden="true" />
              </Link>
              <BuildWithAI />
            </div>
            <div className="framework-command">
              <code>
                bun create sixb <span>my-app</span>
              </code>
              <button
                type="button"
                className="framework-copy"
                onClick={copyCommand}
                aria-label={copyStatus === "copied" ? "Command copied" : "Copy create command"}
              >
                {copyStatus === "copied" ? (
                  <Check size={13} aria-hidden="true" />
                ) : (
                  <Copy size={13} aria-hidden="true" />
                )}
                <span>{copyStatus === "copied" ? "Copied" : "Copy"}</span>
              </button>
              <span
                className={copyStatus === "error" ? "framework-copy-message" : "sr-only"}
                role="status"
              >
                {copyStatus === "copied"
                  ? "Create command copied to clipboard."
                  : copyStatus === "error"
                    ? "Select the command to copy it manually."
                    : ""}
              </span>
            </div>
            <div className="framework-live-example">
              <p>Live example</p>
              <nav aria-label="Live Northline example">
                {[
                  ["Northline", "https://northline.sixb.ai/"],
                  ["Atlas", "https://atlas.northline.sixb.ai/"],
                  ["API docs", "https://northline.sixb.ai/docs"],
                ].map(([label, href]) => (
                  <a key={href} href={href} target="_blank" rel="noopener noreferrer">
                    {label} <ArrowUpRight size={13} aria-hidden="true" />
                  </a>
                ))}
              </nav>
            </div>
          </div>
        </div>

        <div
          className="framework-visual"
          ref={scenario.visual}
          data-phase={scenario.phase}
          data-playing={scenario.playing}
          data-quote-focused={quoteFocused}
        >
          <div className="framework-illustration">
            <FrameworkStack activeLayer={hovered} phase={scenario.phase} />
            <button
              type="button"
              className="framework-quote-target"
              aria-label="Explore the quote and its linked customer, site, and contract"
              onMouseEnter={() => setQuoteFocused(true)}
              onMouseLeave={() => setQuoteFocused(false)}
              onFocus={() => setQuoteFocused(true)}
              onBlur={() => setQuoteFocused(false)}
              onClick={() => selectLayer(layers[1])}
            />
            <div className="framework-layer-controls" aria-label="Explore the Sixb stack">
              {layers.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="framework-layer-label"
                  style={{ top: `${item.top}%` }}
                  aria-controls="explore-the-code"
                  onMouseEnter={() => setHovered(item.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(item.id)}
                  onBlur={() => setHovered(null)}
                  onClick={() => selectLayer(item)}
                >
                  <span className="framework-layer-name">
                    {item.name} <ArrowDown size={13} aria-hidden="true" />
                  </span>
                  <span className="framework-layer-caption">{item.caption}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="framework-action-demo">
            <span className="framework-action-context">
              {created ? "Q-1042 · PandaDoc" : "Q-1042 · $12,400"}
            </span>
            <button
              type="button"
              className="framework-approve"
              disabled={!ready && !created}
              onClick={created ? showAction : scenario.approve}
            >
              {created ? <Check size={10} aria-hidden="true" /> : null}
              {created
                ? "View workflow code"
                : pending
                  ? "Creating…"
                  : ready
                    ? "Create in PandaDoc"
                    : "Preparing quote…"}
            </button>
            <div className="framework-demo-footer">
              <span className="framework-demo-hint">Interactive demo</span>
              <button
                type="button"
                className="framework-replay"
                aria-label="Replay quote demo"
                title="Replay demo"
                disabled={!ready && !created}
                onClick={scenario.replay}
              >
                <RotateCcw size={10} aria-hidden="true" />
              </button>
            </div>
            <span className="sr-only">
              {created
                ? "Quote Q-1042 was created in the simulated PandaDoc system. View the workflow code or replay the demo."
                : ready
                  ? "Quote Q-1042 is ready for review in the demo."
                  : pending
                    ? "Sending the approved quote back to PandaDoc in the demo."
                    : "Preparing a quote from connected customer and site information."}
            </span>
          </div>
        </div>
      </section>

      <div className="framework-explore">
        <button
          type="button"
          className="framework-scroll-cue"
          onClick={showExample}
          aria-label="Explore the framework"
          aria-controls="explore-the-code"
          title="Explore the framework"
        >
          <ArrowDown size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      <FrameworkStory ref={story} />
    </div>
  )
}
