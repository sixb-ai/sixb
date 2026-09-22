import { useEffect, useRef, useState } from "react"

export type ScenarioPhase =
  | "idle"
  | "ingest"
  | "prepare"
  | "model"
  | "ready"
  | "publishing"
  | "created"

// The illustration is a local demonstration; no source-system action is invoked here.
export const scenarioTransitions: Record<
  Exclude<ScenarioPhase, "idle">,
  { next: ScenarioPhase; duration: number }
> = {
  ingest: { next: "prepare", duration: 1100 },
  prepare: { next: "model", duration: 1200 },
  model: { next: "ready", duration: 1100 },
  ready: { next: "publishing", duration: 1600 },
  publishing: { next: "created", duration: 3200 },
  created: { next: "ingest", duration: 2200 },
}

export function useStackScenario() {
  const visual = useRef<HTMLDivElement>(null)
  const remaining = useRef<{ phase: ScenarioPhase; ms: number } | null>(null)
  const [phase, setPhase] = useState<ScenarioPhase>("idle")
  const [inView, setInView] = useState(false)
  const [tabVisible, setTabVisible] = useState(true)
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)")
    function updateMotion() {
      setReducedMotion(media.matches)
      if (media.matches) {
        setPhase((current) => {
          if (current === "created") return current
          return current === "publishing" ? "created" : "ready"
        })
      }
    }
    const updateVisibility = () => setTabVisible(!document.hidden)
    updateMotion()
    updateVisibility()
    media.addEventListener("change", updateMotion)
    document.addEventListener("visibilitychange", updateVisibility)
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? false),
      { threshold: 0.15 }
    )
    if (visual.current) observer.observe(visual.current)
    return () => {
      observer.disconnect()
      media.removeEventListener("change", updateMotion)
      document.removeEventListener("visibilitychange", updateVisibility)
    }
  }, [])

  const playing = inView && tabVisible && !reducedMotion
  useEffect(() => {
    if (!playing) return
    if (phase === "idle") {
      setPhase("ingest")
      return
    }
    const transition = scenarioTransitions[phase]
    // Preserve elapsed time when scrolling away or switching tabs, just as CSS pauses its pulse.
    const started = performance.now()
    const timer = setTimeout(
      () => {
        remaining.current = null
        setPhase(transition.next)
      },
      remaining.current?.phase === phase ? remaining.current.ms : transition.duration
    )
    return () => {
      clearTimeout(timer)
      const duration =
        remaining.current?.phase === phase ? remaining.current.ms : transition.duration
      remaining.current = { phase, ms: Math.max(0, duration - (performance.now() - started)) }
    }
  }, [phase, playing])

  function approve() {
    if (phase !== "ready") return
    remaining.current = null
    setPhase(reducedMotion ? "created" : "publishing")
  }

  function replay() {
    remaining.current = null
    setPhase(reducedMotion ? "ready" : "ingest")
  }

  return { visual, phase, playing, approve, replay }
}
