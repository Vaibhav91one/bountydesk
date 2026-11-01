/**
 * M12 Verdict approved (docs/site/screens/m12.html). The receipt is decided by the report's own
 * state: DELIVERED shows the delivered receipt, DELIVERING the in-progress one, anything else says
 * there is no receipt yet. A report is DELIVERED only after the transport receipt (see AGENTS.md).
 */
import { View, Text, ScrollView, StyleSheet } from "react-native"
import { AnimatedMascot } from "@/components/AnimatedMascot"
import { useRouter, useLocalSearchParams } from "expo-router"

import { deliveryLabel } from "@/lib/delivery-label"
import { useApiQuery, ApiError } from "@/lib/use-query"
import { fixturesEnabled } from "@/lib/fixtures"
import { useTheme } from "@/theme"
import { GlassBlur } from "@/components/GlassBlur"
import { LoadingState, PhasePill, PrimaryButton, TOP_INSET, TopFade } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, KvLine, Note } from "@/components/CaseUi"
import type { CaseFileWithDelivery } from "@/components/VerdictReview"
import { font } from "@/lib/fonts"

export default function VerdictApprovedScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { colors, phase } = useTheme()

  // Fixture mode only: BD-1042 awaits approval on M11 and is delivered on M12, so M12 asks for the receipt view.
  const { data: cf, error, isError } = useApiQuery<CaseFileWithDelivery>(fixturesEnabled() ? `/reports/${id}?as=receipt` : `/reports/${id}`)

  if (isError) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.red }]}>{error?.message ?? "Failed to load case file"}</Text>
      </View>
    )
  }

  if (!cf) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <LoadingState label="Loading receipt" />
      </View>
    )
  }

  const verdict = cf.verdict
  const outcomeLabel = verdict?.outcomeLabel ?? verdict?.outcome ?? ""
  const hashForDisplay = verdict?.contentHash ? `sha256:${verdict.contentHash}` : ""
  const isDelivered = cf.state === "DELIVERED"
  const isDelivering = cf.state === "DELIVERING"
  const channel = deliveryLabel(cf.deliveryChannel ?? cf.channel, cf.delivery?.target)
  const receipt = cf.delivery?.transportReceipt ?? "None yet"
  const deliveredAt = cf.delivery?.deliveredAt
    ? new Date(cf.delivery.deliveredAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/[\u202f\u00a0]/g, " ")
    : ""
  const title = isDelivered ? "Verdict delivered" : isDelivering ? "Approved. Delivery in progress" : "No receipt yet"
  const hasReceipt = isDelivered || isDelivering

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.top}>
          <AnimatedMascot name="celebrating" size={180} float />
          <Text style={[styles.h1, { color: colors.foreground }]}>{title}</Text>
          <Text style={[styles.hmeta, { color: colors.muted }]}>{cf.sourceLabel} · {cf.title}</Text>
        </View>

        {hasReceipt ? (
          <View>
            <SectionHead title={isDelivered ? "Receipt" : "Delivery"} />
            <ListCard>
              <KvLine
                label="Outcome"
                trailing={<PhasePill phase="delivered" label={outcomeLabel} labelStyle={{ color: phase.delivered }} />}
              />
              <KvLine label="Channel" value={channel} divider dashed />
              {isDelivered ? (
                <>
                  <KvLine label="Receipt" value={receipt} mono divider dashed />
                  {deliveredAt ? <KvLine label="Delivered" value={deliveredAt} divider dashed /> : null}
                </>
              ) : (
                <KvLine label="State" value={cf.delivery?.state ?? "Sending"} divider dashed />
              )}
              <Text style={[styles.hash, { color: colors.foreground }]}>{hashForDisplay}</Text>
            </ListCard>
            <Note>
              {isDelivered
                ? "Marked delivered only after GitHub confirmed the comment. An email report shows the mail provider receipt instead."
                : "Delivery is in progress. The verdict will be marked delivered once the transport confirms it."}
            </Note>
          </View>
        ) : (
          <Note>This verdict has not been approved yet, so there is no receipt to show.</Note>
        )}
      </ScrollView>

      <BottomFade />
      <View pointerEvents="none" style={styles.topFade}>
        <TopFade />
      </View>
      <View style={[styles.fbar, { backgroundColor: colors.glass, borderColor: colors["glass-edge"], overflow: "hidden" }]}><GlassBlur />
        <PrimaryButton title="Back to queue" onPress={() => router.replace("/(tabs)")} style={styles.btn} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  scrollContent: { paddingTop: TOP_INSET, paddingBottom: 150 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorText: { fontFamily: font.regular, fontSize: 16 },
  top: { alignItems: "center", paddingTop: 4, paddingBottom: 20, paddingHorizontal: 24 },
  mascot: { width: 180, height: 180 },
  h1: { fontFamily: font.bold, fontSize: 28, lineHeight: 32.2, letterSpacing: -0.84, paddingTop: 6, textAlign: "center" },
  hmeta: { fontFamily: font.regular, fontSize: 15, lineHeight: 20.25, paddingTop: 10, textAlign: "center" },
  hash: { fontFamily: font.mono, fontSize: 13, lineHeight: 20.15, letterSpacing: 0, paddingTop: 12, paddingBottom: 16, paddingHorizontal: 18 },
  topFade: { position: "absolute", top: 0, left: 0, right: 0, height: 124 },
  fbar: { position: "absolute", left: 16, right: 16, bottom: 30, flexDirection: "row", gap: 6, padding: 6, borderRadius: 36, borderWidth: 1 },
  btn: { flex: 1 },
})
