import createGlobe, { type Globe } from "cobe"
import { useEffect, useRef, useState } from "react"

const blue: [number, number, number] = [0, 122 / 255, 1]
const radians = Math.PI / 180
type Location = [latitude: number, longitude: number]

function globeState(location?: Location) {
  return location
    ? {
        phi: 1.5 * Math.PI - location[1] * radians,
        theta: location[0] * radians,
        markers: [{ location, size: 0.055, color: blue }],
      }
    : { phi: -0.82, theta: 0.24, markers: [] }
}

export function MissionGlobe({ location }: { location?: Location }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const locationRef = useRef(location)
  const globeRef = useRef<Globe | null>(null)
  const reducedMotionRef = useRef(false)
  const [failed, setFailed] = useState(false)
  locationRef.current = location

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const canvas = document.createElement("canvas")
    canvas.setAttribute("aria-hidden", "true")
    canvas.style.cssText = "display:block;width:100%;height:100%"
    mount.replaceChildren(canvas)

    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl")
    if (!context) {
      mount.replaceChildren()
      setFailed(true)
      return
    }

    const size = () => ({
      width: Math.max(1, mount.clientWidth),
      height: Math.max(1, mount.clientHeight),
    })
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    reducedMotionRef.current = reduceMotion
    let phi = -0.82
    let theta = 0.24
    let frame = 0
    let stopped = false
    let globe: Globe

    try {
      globe = createGlobe(canvas, {
        ...size(),
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        phi,
        theta,
        dark: 0,
        diffuse: 1.32,
        mapSamples: 24_000,
        mapBrightness: 2.85,
        mapBaseBrightness: 0.025,
        baseColor: [0.88, 0.93, 1],
        markerColor: blue,
        glowColor: [0.82, 0.9, 1],
        markerElevation: 0.025,
        markers: [],
      })
    } catch {
      mount.replaceChildren()
      setFailed(true)
      return
    }
    globeRef.current = globe

    const resize = new ResizeObserver(() => globe.update(size()))
    resize.observe(mount)

    const stop = () => {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(frame)
      resize.disconnect()
      globeRef.current = null
      globe.destroy()
    }
    const handleContextLost = (event: Event) => {
      event.preventDefault()
      stop()
      mount.replaceChildren()
      setFailed(true)
    }
    canvas.addEventListener("webglcontextlost", handleContextLost)

    const render = () => {
      const point = locationRef.current
      const target = globeState(point)
      if (point) {
        phi += Math.atan2(Math.sin(target.phi - phi), Math.cos(target.phi - phi)) * 0.045
        theta += (target.theta - theta) * 0.045
      } else {
        phi += 0.0012
      }
      globe.update({ phi, theta, markers: target.markers })
      frame = requestAnimationFrame(render)
    }

    if (reduceMotion) globe.update(globeState(locationRef.current))
    else render()

    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLost)
      stop()
      mount.replaceChildren()
    }
  }, [])

  useEffect(() => {
    if (!reducedMotionRef.current || !globeRef.current) return
    globeRef.current.update(globeState(location))
  }, [location])

  if (failed) {
    return (
      <div className="grid size-full place-items-center text-sm text-muted-foreground">
        Globe unavailable. Position data remains below.
      </div>
    )
  }

  return (
    <div className="relative size-full">
      <div
        className="absolute inset-[10%] rounded-full border border-[#d4e6ff] bg-[#eef4ff]/35 shadow-[0_24px_48px_rgb(23_24_28_/_0.08)]"
        aria-hidden="true"
      />
      <div
        ref={mountRef}
        className="relative size-full drop-shadow-[0_24px_28px_rgb(23_24_28_/_0.1)]"
      />
    </div>
  )
}
