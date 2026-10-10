import { BlurView } from "expo-blur"
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect"
import type { ReactNode } from "react"
import {
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewProps,
  type ViewStyle,
} from "react-native"
import { palettes, type Scheme, useScheme } from "../lib/theme"

// iOS 26 draws the system's own Liquid Glass. Elsewhere a blur with a translucent fill and a
// fine light rim stands in for it.
const LIQUID_GLASS = isLiquidGlassAvailable() && isGlassEffectAPIAvailable()

interface GlassProps extends ViewProps {
  readonly style?: StyleProp<ViewStyle>
  readonly children?: ReactNode
  /** Force an appearance, for surfaces that are dark in both, such as the connect screen. */
  readonly scheme?: Scheme
}

/** A frosted glass surface for controls that float over content. Shape it with `borderRadius`. */
export function Glass({ style, children, scheme, ...props }: GlassProps) {
  const systemScheme = useScheme()
  const appearance = scheme ?? systemScheme
  if (LIQUID_GLASS) {
    return (
      <GlassView glassEffectStyle="regular" colorScheme={appearance} style={style} {...props}>
        {children}
      </GlassView>
    )
  }
  const palette = palettes[appearance]
  return (
    <View
      style={[
        styles.fallback,
        { backgroundColor: palette.glass, borderColor: palette.glassBorder },
        style,
      ]}
      {...props}
    >
      <BlurView intensity={40} tint={palette.glassTint} style={StyleSheet.absoluteFill} />
      {children}
    </View>
  )
}

interface GlassButtonProps {
  readonly accessibilityLabel: string
  readonly onPress: () => void
  readonly children: ReactNode
  readonly size?: number
  readonly scheme?: Scheme
  readonly disabled?: boolean
}

/** A round glass button for an icon, such as back or close. Its touch target is 44 points. */
export function GlassButton({
  accessibilityLabel,
  onPress,
  children,
  size = 40,
  scheme,
  disabled,
}: GlassButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      hitSlop={Math.max(0, (44 - size) / 2)}
      style={({ pressed }) => [styles.lift, pressed && styles.pressed]}
    >
      <Glass
        scheme={scheme}
        style={[styles.round, { width: size, height: size, borderRadius: size / 2 }]}
      >
        {children}
      </Glass>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fallback: { overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  round: { alignItems: "center", justifyContent: "center" },
  lift: {
    borderRadius: 999,
    shadowColor: "#000000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  pressed: { transform: [{ scale: 0.94 }], opacity: 0.85 },
})
