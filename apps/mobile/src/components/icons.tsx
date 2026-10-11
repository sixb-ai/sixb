import Svg, { Circle, Path, Rect } from "react-native-svg"

interface IconProps {
  readonly size?: number
  readonly color: string
}

// Stroke icons drawn to the design's 24-unit grid. All are decorative: the control that holds one
// carries the accessible label.

export function ChevronDownIcon({ size = 11, color }: IconProps) {
  return (
    <Svg width={size} height={(size * 7) / 11} viewBox="0 0 12 8" fill="none" aria-hidden>
      <Path
        d="M1 1.5l5 5 5-5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function ChevronLeftIcon({ size = 17, color }: IconProps) {
  return (
    <Svg width={(size * 10) / 17} height={size} viewBox="0 0 8 14" fill="none" aria-hidden>
      <Path
        d="M7 1L1 7l6 6"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function ArrowUpIcon({ size = 18, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path
        d="M12 19V5M5.5 11.5L12 5l6.5 6.5"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function StopIcon({ size = 14, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      <Rect x={1} y={1} width={12} height={12} rx={3} fill={color} />
    </Svg>
  )
}

export function CheckIcon({ size = 16, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function AlertIcon({ size = 16, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={2} />
      <Path d="M12 7.5v5.5M12 16.5v.01" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  )
}

export function FileIcon({ size = 14, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path
        d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
        stroke={color}
        strokeWidth={2.2}
        strokeLinejoin="round"
      />
      <Path d="M14 3v5h5" stroke={color} strokeWidth={2.2} strokeLinejoin="round" />
    </Svg>
  )
}

export function QrIcon({ size = 18, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Rect x={3.5} y={3.5} width={6} height={6} rx={1} stroke={color} strokeWidth={2} />
      <Rect x={14.5} y={3.5} width={6} height={6} rx={1} stroke={color} strokeWidth={2} />
      <Rect x={3.5} y={14.5} width={6} height={6} rx={1} stroke={color} strokeWidth={2} />
      <Path
        d="M14.5 14.5h2v2h-2zM18.5 18.5h2v2h-2zM18.5 14.5h2M14.5 20.5h2"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  )
}

export function CloseIcon({ size = 18, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path d="M6 6l12 12M18 6L6 18" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  )
}

export function PlusIcon({ size = 22, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  )
}

export function CameraIcon({ size = 26, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path
        d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.4-2h5.8l1.4 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12.5} r={3.4} stroke={color} strokeWidth={1.8} />
    </Svg>
  )
}

export function PhotoIcon({ size = 26, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Rect x={4} y={4} width={16} height={16} rx={2.5} stroke={color} strokeWidth={1.8} />
      <Circle cx={9} cy={9.5} r={1.6} stroke={color} strokeWidth={1.6} />
      <Path
        d="M4.5 17l4.5-4.5 3 3 2.5-2.5 5 5"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function FileUpIcon({ size = 26, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path
        d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <Path d="M14 3v5h5" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
      <Path
        d="M12.5 17.5v-6M10 14l2.5-2.5L15 14"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function SearchIcon({ size = 17, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Circle cx={10.5} cy={10.5} r={6.5} stroke={color} strokeWidth={2.2} />
      <Path d="M15.5 15.5L20 20" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  )
}

/** A clock with an arrow running back around it, for history. */
export function HistoryIcon({ size = 22, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path
        d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Path
        d="M3.5 4.5v4h4"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M12 7.5V12l3 2"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}
