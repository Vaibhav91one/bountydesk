/**
 * The Review next floating action button.
 *
 * Per docs/site/native-ui.html the Review next action is NOT one of the tab
 * routes — it is a separate 64pt round button that lives beside the tab bar and
 * opens sign/[id] (m11) for the next waiting verdict. It carries a count badge
 * when there are verdicts waiting a decision.
 *
 * Rendered above the native tab bar on the three tab screens only.
 */
import { View, Text, StyleSheet, Pressable } from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { useRouter } from "expo-router"
import { Icon } from "@/components/icons"
import { useTheme } from "@/theme"

export function ReviewFab({ count = 0 }: { count?: number }) {
  const { colors } = useTheme()
  const router = useRouter()

  const handlePress = () => {
    // Open the next waiting verdict; ROUTES.md maps sign/[id] -> m11.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(router as any).push("/reports/BD-1042/sign-the-verdict")
  }

  return (
    <Pressable onPress={handlePress} style={styles.fab} accessibilityLabel={`Review next verdict${count > 0 ? `, ${count} waiting` : ""}`}>
      <LinearGradient colors={[colors.brand, colors.brand]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fabInner}>
        <Icon name="check" size={28} stroke="#ffffff" strokeWidth={2.2} />
        {count > 0 ? (
          <View style={[styles.badge, { backgroundColor: colors.background }]}>
            <Text style={styles.badgeText}>{count}</Text>
          </View>
        ) : null}
      </LinearGradient>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 16,
    bottom: 88,
    width: 64,
    height: 64,
    borderRadius: 32,
    zIndex: 40,
  },
  fabInner: {
    width: "100%",
    height: "100%",
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
})
