import { View, Text, StyleSheet, useColorScheme } from "react-native"

import { darkTheme, lightTheme } from "@/theme"

/**
 * A placeholder screen for every mockup that has not been built yet.
 * Renders the mockup's title and a "Coming soon" message so the route
 * structure is navigable end to end before each screen ships.
 * Uses the same dark theme as docs/site/screens/c.css.
 */
export function StubScreen({ title }: { title: string }) {
  const cs = useColorScheme()
  const t = cs === "dark" ? darkTheme : lightTheme

  return (
    <View style={[styles.container, { backgroundColor: t.colors.background }]}>
      <Text style={[styles.title, { color: t.colors.foreground }]}>{title}</Text>
      <Text style={[styles.subtitle, { color: t.colors.muted }]}>Coming soon</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 17,
  },
})
