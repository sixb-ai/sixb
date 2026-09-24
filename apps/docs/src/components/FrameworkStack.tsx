import { useId } from "react"
import type { StackLayer } from "./HomeWalkthrough"
import { type ScenarioPhase, scenarioTransitions } from "./useStackScenario"

// The return route starts at Build and ends at the PandaDoc connector.
const returnPath = "M48 131H31Q7 131 7 155V652Q7 672 72 684"
const sourcePath = "M194 711V677C194 657 235 657 235 625V612"
const preparePath = "M320 558L255 546.31Q247 544.87 247 536.87V490"
const modelPath = "M239 312V200"

export function FrameworkStack({
  activeLayer,
  phase,
}: {
  activeLayer: StackLayer | null
  phase: ScenarioPhase
}) {
  const id = useId().replace(/:/g, "")
  const arrow = `url(#${id}-arrow)`
  const blueArrow = `url(#${id}-blue-arrow)`
  const created = phase === "created"

  return (
    <svg
      className="framework-stack"
      viewBox="0 0 700 830"
      preserveAspectRatio="none"
      role="img"
      aria-labelledby={`${id}-title ${id}-description`}
      data-active={activeLayer ?? "none"}
    >
      <title id={`${id}-title`}>From customer context to an approved quote</title>
      <desc id={`${id}-description`}>
        Pipedrive, CompanyCam, Google Drive, and PandaDoc connect to a shared model of customers,
        sites, quotes, and contracts. Prepared data flows up to an app, an agent, and an approval
        workflow. Creating the quote sends an action back down to PandaDoc. This is an interactive
        illustration with fictional data; it does not create an external document.
      </desc>
      <defs>
        <linearGradient id={`${id}-plane`} x1="0" y1="0" x2="0.5" y2="1">
          <stop stopColor="var(--stack-paper)" />
          <stop offset="1" stopColor="var(--stack-plane)" />
        </linearGradient>
        <linearGradient id={`${id}-model`} x1="0" y1="0" x2="0.8" y2="1">
          <stop stopColor="var(--stack-paper)" />
          <stop offset="1" stopColor="var(--stack-blue-wash)" />
        </linearGradient>
        <marker
          id={`${id}-arrow`}
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M0 0 6 3 0 6Z" fill="var(--stack-fine)" stroke="none" />
        </marker>
        <marker
          id={`${id}-blue-arrow`}
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M0 0 6 3 0 6Z" fill="var(--docs-accent)" stroke="none" />
        </marker>
      </defs>

      <g className="stack-connections stack-flow" fill="none">
        <path d="M101 322V175" markerEnd={arrow} />
        <path d={modelPath} markerEnd={blueArrow} className="stack-blue-line stack-quote-related" />
        <path d="M400 375V229" markerEnd={arrow} />
        <path
          d="M247 549V418"
          markerEnd={blueArrow}
          className="stack-blue-line stack-quote-related"
        />
        {phase === "model" && (
          <Pulse path={modelPath} duration={scenarioTransitions.model.duration} />
        )}
      </g>

      <g className="stack-stage" data-layer="connect">
        <Plane x={17} y={728} fill={`url(#${id}-plane)`} />
        {/* Draw continuous routes above the plane and behind the connector faces.
            Each curve meets the shared stem with a vertical tangent. */}
        <g className="stack-connections stack-flow" fill="none">
          <path d="M100 692V660C100 645 235 663 235 625" />
          <path d="M289 729V692C289 664 235 663 235 625" />
          <path d="M382 746V708C382 668 235 677 235 625" />
          <path d={sourcePath} markerEnd={blueArrow} className="stack-quote-related" />
          {phase === "ingest" && (
            <Pulse path={sourcePath} duration={scenarioTransitions.ingest.duration} />
          )}
        </g>
        <Integration
          x={82}
          y={664}
          label="PandaDoc"
          logo="pandadoc.png"
          active={created}
          destination
        />
        <Integration
          x={176}
          y={681}
          label="Pipedrive"
          logo="pipedrive.png"
          active={phase === "ingest"}
        />
        <Integration x={270} y={698} label="CompanyCam" logo="companycam.png" />
        <Integration x={364} y={715} label="Google Drive" logo="google-drive.svg" />
      </g>

      <g className="stack-stage" data-layer="prepare">
        <Plane x={21} y={558} fill={`url(#${id}-plane)`} />
        <g className="stack-connections" fill="none">
          <path className="stack-blue-line" d="M173 539 303 562.39" markerEnd={blueArrow} />
          <path
            d={preparePath}
            markerEnd={blueArrow}
            className="stack-blue-line stack-quote-related"
          />
          {phase === "prepare" && (
            <Pulse path={preparePath} duration={scenarioTransitions.prepare.duration} />
          )}
        </g>
        <Dataset x={119} y={502} />
        <Dataset x={337} y={541.22} />
        <TransformStep x={200} y={527} variant="filter" />
        <TransformStep x={257} y={537.25} variant="transform" />
        <g transform="translate(215 471)" className="stack-projection">
          <rect className="stack-paper" width="64" height="19" rx="3" />
          <text x="32" y="12.5" className="stack-micro stack-blue-text" textAnchor="middle">
            projection
          </text>
        </g>
      </g>

      <g className="stack-stage" data-layer="model">
        <Plane x={15} y={377} fill={`url(#${id}-model)`} />
        <g className="stack-connections stack-model-links" fill="none">
          <path d="M105 353 164 376 240 373" />
          <path d="M240 373 340 397 400 375" />
          <path d="M240 373 400 375" />
          <g className="stack-action-link">
            <path d="M280 306H284Q290 306 290 300V257Q290 251 297 251" />
            <circle className="stack-blue-fill" cx="280" cy="306" r="1.5" />
          </g>
        </g>
        <g className="stack-site">
          <ObjectBase x={101} y={351} rx={38} />
          <Office x={78} y={274} />
          <text className="stack-caption" x="101" y="381" textAnchor="middle">
            Site
          </text>
        </g>
        <g className="stack-quote">
          <ObjectBase x={239} y={374} rx={61} />
          <QuoteDocument x={197} y={278} created={created} />
          <text className="stack-caption" x="239" y="410" textAnchor="middle">
            Quote
          </text>
        </g>
        <g className="stack-contract" transform="translate(-8 6)">
          <ObjectBase x={408} y={369} rx={32} />
          <ContractDocument x={389} y={310} />
          <text className="stack-caption" x="408" y="396" textAnchor="middle">
            Contract
          </text>
        </g>
        <g className="stack-customer" transform="translate(0 -10)">
          <ObjectBase x={336} y={408} rx={34} />
          <Customer x={309} y={357} />
          <text className="stack-caption" x="336" y="436" textAnchor="middle">
            Customer
          </text>
        </g>
      </g>

      <g className="stack-stage" data-layer="build">
        <Plane x={25} y={149} fill={`url(#${id}-plane)`} />
        <text className="stack-caption" x="144" y="29" textAnchor="middle">
          Apps
        </text>
        <AppWindow x={102} y={40} phase={phase} />
        <text className="stack-caption" x="278" y="53" textAnchor="middle">
          Agents
        </text>
        <AgentWindow x={241} y={65} phase={phase} />
        <text className="stack-caption" x="405" y="77" textAnchor="middle">
          Workflows
        </text>
        <Workflow x={357} y={88} phase={phase} />
      </g>

      <path
        className="stack-return stack-flow"
        d={returnPath}
        fill="none"
        markerEnd={phase === "publishing" ? blueArrow : arrow}
      />
      {phase === "publishing" && (
        <Pulse path={returnPath} duration={scenarioTransitions.publishing.duration} />
      )}
      <g className="stack-leaders" fill="none">
        {[162, 377, 559, 730].map((y) => (
          <g key={y}>
            <path d={`M483 ${y - 12}h10l12 12h10`} />
            <circle cx="483" cy={y - 12} r="1.6" />
          </g>
        ))}
      </g>
    </svg>
  )
}

function Pulse({ path, duration }: { path: string; duration: number }) {
  return (
    <path
      className="stack-pulse"
      d={path}
      pathLength="1"
      style={{ animationDuration: `${duration}ms` }}
      aria-hidden="true"
    />
  )
}

function QuoteDocument({ x, y, created }: { x: number; y: number; created: boolean }) {
  return (
    <g transform={`matrix(1 .17 0 1 ${x} ${y})`}>
      <rect className="stack-side" x="5" y="-4" width="78" height="82" rx="2" />
      <rect className="stack-paper stack-quote-sheet" width="78" height="82" rx="2" />
      <path className="stack-blue-fill" d="M2 0H76Q78 0 78 2V24H0V2Q0 0 2 0Z" />
      <text className="stack-number stack-white-text" x="8" y="16">
        Q-1042
      </text>
      <text className="stack-mini-copy" x="8" y="35">
        Riverside
      </text>
      <path className="stack-fine-line" d="M8 41H70M8 53H70M8 64H70" />
      <path className="stack-soft-line" d="M9 47H34M55 47H69M9 59H41M57 59H69" />
      <text className="stack-number stack-blue-text" x="70" y="75" textAnchor="end">
        $12,400
      </text>
      <g transform="translate(58 -9)">
        <circle r="7" className="stack-blue-fill" />
        {created ? (
          <path className="stack-white-line" d="m-3 0 2 2 4 -4" />
        ) : (
          <path className="stack-white-line" d="m-3 2 1 -4 4 -1 1 1 -4 4Z" />
        )}
      </g>
    </g>
  )
}

function Customer({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`matrix(1 .17 0 1 ${x} ${y})`}>
      <rect className="stack-side" x="4" y="-3" width="53" height="43" rx="3" />
      <rect className="stack-paper" width="53" height="43" rx="3" />
      <path className="stack-fine-line" d="M0 9H53" />
      <circle className="stack-blue-wash" cx="15" cy="23" r="10" stroke="none" />
      <circle className="stack-blue-fill" cx="15" cy="20" r="3" />
      <path className="stack-blue-fill" d="M9 29Q9 24 15 24Q21 24 21 29Z" />
      <path className="stack-soft-line" d="M30 19H45M30 25H40" />
      <text className="stack-mini-copy" x="26.5" y="38" textAnchor="middle">
        Riverside
      </text>
    </g>
  )
}

function ContractDocument({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`matrix(1 .17 0 1 ${x} ${y})`}>
      <path className="stack-side" d="M4 -3H30L39 6V49H4Z" />
      <path className="stack-paper" d="M0 0H26L35 9V52H0Z M26 0V9H35" />
      <path className="stack-soft-line" d="M7 15H26" />
      <path className="stack-fine-line" d="M7 23H28M7 28H23M7 33H27M7 46H28" />
      <path className="stack-blue-line" d="M8 43q8 -13 6 -4t7 -1q0 4 7 2" />
      <path className="stack-blue-fill" d="m30 32 5 1v14l-2 -2 -3 1Z" />
    </g>
  )
}

function AppWindow({ x, y, phase }: { x: number; y: number; phase: ScenarioPhase }) {
  return (
    <g transform={`matrix(1 .17 0 1 ${x} ${y})`}>
      <rect className="stack-side" x="4" y="-4" width="91" height="92" rx="3" />
      <rect className="stack-paper" width="91" height="92" rx="3" />
      <path className="stack-fine-line" d="M0 12H91M14 12V92" />
      {[6, 11, 16].map((cx) => (
        <circle key={cx} cx={cx} cy="6" r="1" className="stack-ink-fill" />
      ))}
      {[23, 34, 45, 56, 67].map((cy, i) => (
        <rect
          key={cy}
          x="5"
          y={cy}
          width="4"
          height="4"
          rx="1"
          className={i === 1 ? "stack-blue-fill" : "stack-window"}
        />
      ))}
      <text x="21" y="25" className="stack-micro">
        Quotes
      </text>
      <path className="stack-fine-line" d="M21 33H83M21 64H83M21 79H83" />
      <rect x="19" y="36" width="65" height="25" rx="2" className="stack-blue-wash" stroke="none" />
      <text x="23" y="46" className="stack-mini-copy">
        Q-1042
      </text>
      <text x="23" y="57" className="stack-micro stack-blue-text">
        $12,400
      </text>
      <text x="23" y="74" className="stack-mini-copy stack-blue-text">
        {phase === "created"
          ? "Created"
          : phase === "publishing"
            ? "Approved"
            : phase === "ready"
              ? "Review"
              : "Draft"}
      </text>
      <path className="stack-soft-line" d="M23 85H43M61 85H77" />
    </g>
  )
}

function AgentWindow({ x, y, phase }: { x: number; y: number; phase: ScenarioPhase }) {
  return (
    <g transform={`matrix(1 .17 0 1 ${x} ${y})`}>
      <path className="stack-side" d="M4 -3H70Q75 -3 75 3V68Q75 73 70 73H4Z" />
      <path
        className="stack-paper"
        d="M5 0H66Q71 0 71 5V67Q71 72 66 72H19L8 81V72H5Q0 72 0 67V5Q0 0 5 0Z"
      />
      <g transform="translate(8 5) scale(.014)" className="stack-blue-fill">
        <path d="M15.94,471.64l67.46,455.36,599.79-189.73,380.88-355.72L368.99,153C243.22,266.91,122.33,375.93,15.94,471.64Z" />
      </g>
      <text x="8" y="25" className="stack-mini-copy">
        <tspan x="8">Quote</tspan>
        <tspan x="8" dy="11">
          assistant
        </tspan>
      </text>
      <rect x="8" y="45" width="55" height="16" rx="2" className="stack-blue-fill" stroke="none" />
      <text x="35.5" y="55.5" className="stack-micro stack-white-text" textAnchor="middle">
        {phase === "created"
          ? "Created"
          : phase === "publishing"
            ? "Approved"
            : phase === "ready"
              ? "Review"
              : "Preparing"}
      </text>
    </g>
  )
}

function Workflow({ x, y, phase }: { x: number; y: number; phase: ScenarioPhase }) {
  const published = phase === "created" || phase === "publishing"
  const step = published ? 2 : phase === "ready" ? 1 : 0
  return (
    <g transform={`matrix(1 .17 0 1 ${x} ${y})`}>
      <path className="stack-blue-line" d="M36 17V35M36 52V72" />
      {["Draft", "Review", "Publish"].map((label, index) => (
        <g key={label}>
          <rect
            x="12"
            y={index * 34}
            width="48"
            height="18"
            rx="2"
            className={index === step ? "stack-blue-fill" : "stack-paper"}
          />
          <text
            x="36"
            y={index * 34 + 11.5}
            className={`stack-mini-copy ${index === step ? "stack-white-text" : ""}`}
            textAnchor="middle"
          >
            {label}
          </text>
        </g>
      ))}
    </g>
  )
}

function Integration({
  x,
  y,
  label,
  logo,
  active = false,
  destination = false,
}: {
  x: number
  y: number
  label: string
  logo: string
  active?: boolean
  destination?: boolean
}) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      className="stack-integration"
      data-active={active}
      data-destination={destination}
    >
      <path className="stack-side" d="M-9 29 7 19 47 26 34 40 -9 33Z" />
      <path className="stack-paper" d="M-9 29 7 19 47 26 34 36Z" />
      <g transform="matrix(1 .17 0 1 0 -12)">
        <rect className="stack-side" x="3" y="-3" width="37" height="38" rx="3" />
        <rect className="stack-source-face" width="37" height="38" rx="3" />
        <image
          href={`/assets/landing/${logo}`}
          x="7"
          y="7"
          width="24"
          height="24"
          preserveAspectRatio="xMidYMid meet"
        />
        {destination && active && (
          <g transform="translate(34 2)">
            <circle r="5.5" className="stack-blue-fill" />
            <path className="stack-white-line" d="m-2.5 0 1.7 1.7 3 -3.5" />
          </g>
        )}
      </g>
      <text className="stack-source-caption" x="17" y="48" textAnchor="middle">
        {label}
      </text>
    </g>
  )
}

function Plane({ x, y, fill }: { x: number; y: number; fill: string }) {
  // All four platforms share the same size, projected axes, and vertical thickness.
  // Anchor at the front-left corner; only the position varies between layers.
  const backLeft = [x + 81, y - 88]
  const backRight = [x + 459, y - 20]
  const frontRight = [x + 378, y + 68]
  const frontLeft = [x, y]
  const points = [backLeft, backRight, frontRight, frontLeft].map((p) => p.join(",")).join(" ")
  const edge = [frontLeft, frontRight, backRight]
  const front = edge.map((p) => p.join(",")).join(" ")
  const lower = [...edge]
    .reverse()
    .map(([x, y]) => `${x},${y! + 6}`)
    .join(" ")
  return (
    <g className="stack-plane">
      <polygon className="stack-side" points={`${front} ${lower}`} />
      <polygon points={points} fill={fill} />
    </g>
  )
}

function ObjectBase({ x, y, rx }: { x: number; y: number; rx: number }) {
  return (
    <g>
      <ellipse className="stack-side" cx={x} cy={y + 4} rx={rx} ry={rx * 0.34} />
      <ellipse className="stack-paper" cx={x} cy={y} rx={rx} ry={rx * 0.34} />
    </g>
  )
}

function Office({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path className="stack-paper" d="M0 10 32 16V78L0 70Z" />
      <path className="stack-side" d="M32 16 47 4V64L32 78Z" />
      <path className="stack-paper" d="M0 10 15 0 47 4 32 16Z M6 9 16 3 38 6 30 12Z" />
      {[0, 1, 2, 3].map((row) => (
        <g key={row}>
          {[0, 1, 2].map((col) => (
            <path
              key={col}
              className="stack-window"
              d={`M${5 + col * 9} ${22 + row * 11 + col * 1.7}l4 .8v6l-4 -.8Z`}
            />
          ))}
          <path className="stack-window" d={`M37 ${22 + row * 10}l5 -4v6l-5 4Z`} />
        </g>
      ))}
      <path className="stack-side" d="M12 61 21 63V75L12 73Z" />
      <g className="stack-fine-line">
        <path d="M-9 69V56m63 7V49" />
        <ellipse cx="-9" cy="53" rx="4.5" ry="7" fill="var(--stack-tree)" />
        <ellipse cx="54" cy="47" rx="4" ry="6" fill="var(--stack-tree)" />
      </g>
    </g>
  )
}

function Dataset({ x, y }: { x: number; y: number }) {
  return (
    <g className="stack-dataset" transform={`translate(${x} ${y})`}>
      <polygon className="stack-dataset-shadow" points="2,3 93.08,19.38 48.23,68.11 -42.85,51.73" />
      {/* Extrude vertically in scene space so the table has depth, not just a skewed border. */}
      <path className="stack-blue-wash" d="M-44.85 34.73 46.23 51.11V61.11L-44.85 44.73Z" />
      <path className="stack-side" d="M91.08 2.38 46.23 51.11V61.11L91.08 12.38Z" />
      {/* Match the prepare plane's axes: (378, 68) and (-81, 88). */}
      <g transform="matrix(.92 .1655 -.65 .70617 0 -14)">
        <rect className="stack-paper" width="99" height="69" />
        <rect className="stack-data-row" y="43" width="99" height="9" stroke="none" />
        <g className="stack-fine-line">
          {[9, 17, 26, 35, 43, 52, 61].map((y) => (
            <path key={y} d={`M0 ${y}H99`} />
          ))}
          {[25, 50, 75].map((x) => (
            <path key={x} d={`M${x} 0V69`} />
          ))}
        </g>
        <path className="stack-soft-line" d="M5 4H19M30 4H43M55 4H67M80 4H93" />
      </g>
    </g>
  )
}

function TransformStep({
  x,
  y,
  variant,
}: {
  x: number
  y: number
  variant: "filter" | "transform"
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path className="stack-paper" d="M0 5 9 -4.78 32 -.64 23 9.14Z" />
      <path className="stack-side" d="M23 9.14 32 -.64V19.36L23 29.14Z" />
      <path className="stack-paper" d="M0 5 23 9.14V29.14L0 25Z" />
      <path
        className="stack-fine-line"
        fill="none"
        d={variant === "filter" ? "m6 12 11 2 -4 4v5l-3 -1v-5Z" : "m8 13 7 5 -7 3"}
      />
    </g>
  )
}
