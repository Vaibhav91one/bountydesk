/**
 * Stack for the Settings / Connections / Integrations group.
 *
 * These are chrome routes opened from the bell/more top pill on the three tabs;
 * they are not tabs themselves (docs/site/native-ui.html).
 */
import { Stack } from "expo-router"

export default function MoreLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }} />
}
