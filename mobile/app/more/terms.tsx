/** M25 Terms. Legal, native reading layout.
 * Matches docs/site/screens/m25.html exactly.
 *
 * Text is copied verbatim from the mockup article content.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"
import { useTheme } from "@/theme"
import { ScreenHeader } from "@/components/primitives"

export default function TermsScreen() {
  const { colors } = useTheme()

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Terms" back backLabel="Settings" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <Text style={[styles.h1, { color: colors.foreground }]}>Terms</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>Last updated September 2026</Text>

        <View style={styles.article}>
          <Text style={[styles.lead, { color: colors.foreground }]}>
            BountyDesk is a demonstration project. There is no company behind it and it is not a paid service. It takes a security report, reproduces the reported issue against a target it has been authorized to test, and delivers a verdict only after a person approves the exact wording. These terms cover how you may use it while it runs in that form.
          </Text>

          <Text style={[styles.h2, { color: colors.foreground }]}>Authorized targets only</Text>
          <Text style={[styles.p, { color: colors.foreground }]}>
            Reproduction runs against a target profile held on the server, never against a target you name yourself. Use BountyDesk only against the targets it is configured and authorized to test. Do not use it to probe, attack, or gather information about any system you do not own or have permission to test, and do not submit reports whose purpose is to abuse the sandbox or reach anything outside the target.
          </Text>

          <Text style={[styles.h2, { color: colors.foreground }]}>Provided as is</Text>
          <Text style={[styles.p, { color: colors.foreground }]}>
            The service is provided as is, with no warranty of any kind. Its verdicts are the output of an automated agent that a person reviews, not a professional security audit, and a reproduced or not-reproduced result can be wrong. There is no guarantee that the service is available, correct, or fit for any purpose, and you are responsible for what you do with anything it produces.
          </Text>

          <Text style={[styles.h2, { color: colors.foreground }]}>Contact</Text>
          <Text style={[styles.p, { color: colors.foreground }]}>
            BountyDesk is developed in the open at github.com/Vaibhav91one/bountydesk. Open an issue there with any question about these terms or the project.
          </Text>

          <Text style={[styles.end, { color: colors.muted }]}>
            BountyDesk is a demonstration project with no company behind it.
          </Text>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: {
    paddingTop: 62,
    paddingBottom: 40,
  },
  h1: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.03 * 28,
    lineHeight: 32,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  hmeta: {
    fontSize: 15,
    lineHeight: 20,
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  article: {
    paddingHorizontal: 20,
  },
  h2: {
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 24,
    letterSpacing: -0.02 * 20,
    marginTop: 32,
    marginBottom: 10,
  },
  lead: {
    fontSize: 17,
    lineHeight: 26,
    marginTop: 0,
    marginBottom: 0,
    opacity: 0.88,
  },
  p: {
    fontSize: 17,
    lineHeight: 26,
    opacity: 0.88,
    marginBottom: 0,
  },
  end: {
    fontSize: 13,
    marginTop: 32,
  },
})
