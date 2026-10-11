import { View, Text, StyleSheet } from "react-native"

/**
 * A placeholder screen for every mockup that has not been built yet.
 * Renders the mockup's title and a "Coming soon" message so the route
 * structure is navigable end to end before each screen ships.
 */
export function StubScreen({ title }: { title: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>Coming soon</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    backgroundColor: "#1a1a1f",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 17,
    color: "#919199",
  },
})
