/**
 * M12 Verdict approved. Confirmation screen after a verdict is delivered.
 * Shows a celebrating mascot, the report id/title, and a receipt card with
 * outcome, channel, transport receipt, delivered time, and the content hash.
 * A Back to queue button returns to the Home/Queue.
 *
 * Matches docs/site/screens/m12.html pixel for pixel (c.css tokens from theme.ts).
 */
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"

import { useApiQuery, ApiError } from "@/lib/use-query"
import type { MobileCaseFile } from "@/lib/types"
import { useTheme } from "@/theme"
import { PhasePill, Card, KvRow, Mono, PrimaryButton, ToastProvider, Row } from "@/components/primitives"

import { SvgImage } from "@/components/SvgImage"

type CaseFileWithDelivery = MobileCaseFile & {
  delivery: {
    state: string
    deliveredAt: string | null
    requiresHumanReview: boolean
    transportReceipt?: string | null
    target?: string | null
  } | null
}

export default function VerdictApprovedScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { colors, phase } = useTheme()

  const { data: cf, error, isError } = useApiQuery<CaseFileWithDelivery>(`/reports/${id}`)

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
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors.muted }}>Loading</Text>
      </View>
    )
  }

  const verdict = cf.verdict
  const outcomeLabel = verdict?.outcomeLabel ?? verdict?.outcome ?? "Delivered"
  const hashForDisplay = verdict?.contentHash ? `sha256:${verdict.contentHash}` : ""
  // M12 receipt rows.
  const channel = cf.delivery?.transportReceipt ?? cf.delivery?.target ?? "Delivered"
  const receipt = cf.delivery?.transportReceipt ?? "Delivered"
  // Delivered time — mockup shows a time like "9:41 AM".
  const deliveredAt = cf.delivery?.deliveredAt ? new Date(cf.delivery.deliveredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ToastProvider>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          {/* Mascot */}
          <View style={styles.mascotBox}>
            <SvgImage name="mascot/celebrating" width={180} height={180} />
            <Text style={[styles.h1, { color: colors.foreground }]}>Verdict delivered</Text>
            <Text style={[styles.hmeta, { color: colors.muted }]}>{cf.id} · {cf.title}</Text>
          </View>

          {/* Receipt card */}
          <View style={styles.sect}>
            <Text style={[styles.shPlain, { color: colors.foreground }]}>Receipt</Text>
            <Card style={styles.receiptCard}>
              <Row style={styles.receiptRow}>
                <Text style={[styles.kvLabel, { color: colors.muted }]}>Outcome</Text>
                <PhasePill phase="delivered" label={outcomeLabel} labelStyle={{ color: phase.delivered }} />
              </Row>
              <KvRow label="Channel" value={channel} />
              <KvRow label="Receipt" value={receipt} mono />
              {deliveredAt ? <KvRow label="Delivered" value={deliveredAt} /> : null}
              <Mono style={[styles.hash, { color: colors.foreground }] as any}>{hashForDisplay}</Mono>
            </Card>
            <Text style={[styles.note, { color: colors.muted }]}>
              Marked delivered only after GitHub confirmed the comment. An email report shows the mail provider receipt instead.
            </Text>
          </View>
        </ScrollView>

        {/* Back to queue button (matches .fbar .btn) */}
        <View style={styles.fbar}>
          <PrimaryButton title="Back to queue" onPress={() => router.replace("/(tabs)")} />
        </View>
      </ToastProvider>
    </View>
  )
}

const styles = StyleSheet.create({
  scrollContent: { paddingTop: 40, paddingBottom: 80 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorText: { fontSize: 16 },
  mascotBox: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "auto", paddingHorizontal: 24, paddingBottom: 20 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.84, paddingTop: 6, textAlign: "center" },
  hmeta: { fontSize: 15, lineHeight: 20, paddingTop: 10, textAlign: "center" },
  sect: { marginBottom: 28, marginHorizontal: 16 },
  shPlain: { fontSize: 20, fontWeight: "600", lineHeight: 24, marginBottom: 12 },
  cardList: { borderRadius: 24, overflow: "hidden" },
  receiptCard: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden" },
  receiptRow: { paddingVertical: 10, paddingHorizontal: 18, minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  kvLabel: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  hash: { padding: 18, fontSize: 13, lineHeight: 20 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, paddingTop: 10 },
  fbar: { position: "absolute", left: 16, right: 16, bottom: 30, padding: 6 },
})
