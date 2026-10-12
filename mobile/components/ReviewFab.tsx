/**
 * The Review next floating action button (c.css .fab).
 *
 * Per docs/site/native-ui.html Review next is not a tab: it is a 64pt round button beside the tab
 * bar that opens the sign screen for the next report waiting on a decision. The badge is the
 * number of reports awaiting approval, read from the same /home and /queue queries the tabs use.
 *
 * Rendered by <TabDock> beside the tab pill, so it shows on the three tab screens only.
 */
import { View, Text, StyleSheet, Pressable } from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { useRouter } from "expo-router"
import { Icon } from "@/components/icons"
import { useApiQuery } from "@/lib/use-query"
import type { HomeSummary, QueueColumnView } from "@/lib/types"
import { useTheme } from "@/theme"
import { font } from "@/lib/fonts"

export function ReviewFab({ count }: { count?: number }) {
  const { colors } = useTheme()
  const router = useRouter()
  const home = useApiQuery<HomeSummary>("/home")
  const queue = useApiQuery<{ columns: QueueColumnView[] }>("/queue?limit=50")

  const waiting = count ?? home.data?.needsYou ?? 0
  const next = queue.data?.columns.find((c) => c.key === "awaiting-approval")?.cards[0]

  const handlePress = () => {
    // The oldest waiting report would be next; the newest card is first in the column.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(router as any).push(next ? `/reports/${next.id}/sign-the-verdict` : "/inbox")
  }

  return (
    <>
      <LinearGradient
        pointerEvents="none"
        colors={[colors.background + "00", colors.background, colors.background]}
        locations={[0, 0.78, 1]}
        style={styles.bottomFade}
      />
      <Pressable
        onPress={handlePress}
        style={[styles.fab, { backgroundColor: colors.brand, shadowColor: colors.brand }]}
        accessibilityLabel={`Review next verdict${waiting > 0 ? `, ${waiting} waiting` : ""}`}
      >
        <Icon name="check" size={28} stroke="#ffffff" strokeWidth={2.2} />
        {waiting > 0 ? (
          <View style={[styles.badge, { backgroundColor: colors.foreground, borderColor: colors.background }]}>
            <Text style={[styles.badgeText, { color: colors.background }]}>{waiting}</Text>
          </View>
        ) : null}
      </Pressable>
    </>
  )
}

const styles = StyleSheet.create({
  bottomFade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 150, zIndex: 20 },
  fab: {
    position: "absolute",
    right: 16,
    bottom: 30,
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 40,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
  },
  badge: {
    position: "absolute",
    top: -3,
    right: -3,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontFamily: font.bold, fontSize: 13, lineHeight: 18, textAlign: "center" },
})
