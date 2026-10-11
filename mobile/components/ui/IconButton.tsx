/**
 * 22px stroke icon button.
 *
 * Path data is copied verbatim from docs/site/screens/c.js (see
 * components/icons.tsx) so the native icons match the mockups pixel for pixel:
 * viewBox 0 0 24 24, fill none, stroke-width 1.8, round caps and joins.
 * The `more` icon is three dots (c.js D(5,12)+D(12,12)+D(19,12)).
 */
import { StyleSheet, Pressable } from "react-native"
import { Icon } from "@/components/icons"
import type { IconName } from "@/components/icons"
import type { ComponentProps } from "react"

export { Icon, IconName }

interface IconButtonProps extends ComponentProps<typeof Pressable> {
  name: IconName
  size?: number
  stroke?: string
  strokeWidth?: number
  style?: any
}

export function IconButton({ name, size = 22, stroke, strokeWidth, style, onPress, ...rest }: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.ib, style]}
      {...rest}
    >
      <Icon name={name} size={size} stroke={stroke} strokeWidth={strokeWidth} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  ib: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
})
