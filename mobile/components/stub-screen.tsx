/**
 * A placeholder screen for every mockup that has not been built yet.
 * Renders the mockup's title via ScreenHeader and a "Coming soon" message so the
 * route structure is navigable end to end before each screen ships. Uses the
 * theme tokens from c.css (dark by default).
 */
import { View } from "react-native"
import { ScreenHeader, EmptyState } from "@/components/primitives"
import { useTheme } from "@/theme"

export function StubScreen({ title, back = false, backLabel }: { title: string; back?: boolean; backLabel?: string }) {
  const { colors } = useTheme()
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title={title} back={back} backLabel={backLabel} />
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 }}>
        <EmptyState mascot="chilling" heading="Coming soon" body={`The ${title} screen is a stub.`} inline />
      </View>
    </View>
  )
}
