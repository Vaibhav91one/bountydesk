/** M24 Privacy. Legal, native reading layout.
 * Matches docs/site/screens/m24.html exactly.
 *
 * Text is copied verbatim from the mockup article content.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"
import { useTheme } from "@/theme"
import { ScreenHeader } from "@/components/primitives"

export default function PrivacyScreen() {
  const { colors } = useTheme()

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Privacy" back backLabel="Settings" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <Text style={[styles.h1, { color: colors.foreground }]}>Privacy</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>Last updated September 2026</Text>

        <View style={styles.article}>
          <Text style={[styles.lead, { color: colors.foreground }]}>
            BountyDesk is a demonstration project with no company behind it. This page describes the data it handles as it runs today. It does not sell data, and it shares nothing beyond the services it needs to do its job: GitHub for issues, the model provider that runs the agent, and the email provider that delivers a verdict.
          </Text>

          <Text style={[styles.h2, { color: colors.foreground }]}>Signing in</Text>
          <Text style={[styles.p, { color: colors.foreground }]}>
            Signing in with Google or GitHub goes through Clerk and identifies you as a reviewer. BountyDesk reads your account identity from Clerk and checks it against a reviewer allowlist. It does not see your password.
          </Text>

          <Text style={[styles.h2, { color: colors.foreground }]}>What the system stores</Text>
          <Text style={[styles.p, { color: colors.foreground }]}>
            It keeps the reports it is sent and their evidence, the reporter contact address it needs to deliver a verdict by email, the GitHub account, installation, and repository metadata it receives through the GitHub App, the target configuration it is authorized to touch, the raw inbound webhook and email payloads, processing errors, the verdict and delivery text a reviewer approves, the delivery provider's response to each attempt, and a step-by-step log of each agent session.
          </Text>

          <Text style={[styles.h2, { color: colors.foreground }]}>GitHub access</Text>
          <Text style={[styles.p, { color: colors.foreground }]}>
            Through the GitHub App, BountyDesk asks for the least access it needs: read access to repository metadata and read and write access to issues, so it can read a report and post an approved verdict back. A connected public repository is cloned anonymously. When an installation is suspended or removed, intake and delivery stop.
          </Text>

          <Text style={[styles.h2, { color: colors.foreground }]}>Retention</Text>
          <Text style={[styles.p, { color: colors.foreground }]}>
            Because this is a demonstration, data is kept for as long as the project runs and is not on a fixed deletion schedule. Some records are deliberately permanent: a verdict, an approval decision, a session event, and a delivery attempt cannot be edited or deleted, so there is an honest, tamper-evident trail of what was decided and sent.
          </Text>

          <Text style={[styles.h2, { color: colors.foreground }]}>Contact</Text>
          <Text style={[styles.p, { color: colors.foreground }]}>
            BountyDesk is developed in the open at github.com/Vaibhav91one/bountydesk. Open an issue there with any question about your data or the project.
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
