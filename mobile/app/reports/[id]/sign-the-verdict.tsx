/**
 * M11 Sign the verdict. Shows the agent's drafted outcome, severity, delivery
 * channel, the exact comment text, and its sha256 content hash. Approve runs a
 * biometric re-confirm then POSTs { verdictId, contentHash }, sending back the
 * exact hash returned by the API with the displayed text. Deny opens a sheet
 * over the screen with reason radios and an optional note.
 *
 * Matches docs/site/screens/m11.html pixel for pixel (c.css tokens from theme.ts).
 */
import { useState, useMemo, useCallback } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import * as LocalAuthentication from "expo-local-authentication"
import * as Haptics from "expo-haptics"

import { useApiQuery, ApiError } from "@/lib/use-query"
import { api } from "@/lib/api"
import type { MobileCaseFile } from "@/lib/types"
import { useTheme } from "@/theme"
import { Icon } from "@/components/icons"
import { PhasePill, Card, Row, Mono, PrimaryButton, Sheet, ToastProvider, useToast } from "@/components/primitives"

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

// The server returns transportReceipt and target on the delivery object (see
// docs/mobile-api.md), but the shared MobileCaseFile type omits them. Extend
// locally so the screens can read them without editing lib/types.ts.
type CaseFileWithDelivery = MobileCaseFile & {
  delivery: {
    state: string
    deliveredAt: string | null
    requiresHumanReview: boolean
    transportReceipt?: string | null
    target?: string | null
  } | null
}

function deliveryLabel(cf: CaseFileWithDelivery): string {
  const d = cf.delivery
  if (d?.target) {
    const t = d.target
    if (/^github:/.test(t) && /:issue:/.test(t)) return "Comment on GitHub issue"
    if (/^github:/.test(t) && /:advisory:/.test(t)) return "Update security advisory"
    if (t.includes("@")) return "Email to reporter"
  }
  if (cf.channel === "github") return "Comment on GitHub issue"
  return cf.channel || "Unknown"
}

function maxSeverity(cf: CaseFileWithDelivery): string | null {
  const v = cf.verdict
  if (!v || !v.findings || v.findings.length === 0) return null
  let best: string | null = null
  let bestRank = Infinity
  for (const f of v.findings) {
    const sev = (f as { severity?: string }).severity
    if (!sev) continue
    const rank = SEVERITY_ORDER[sev.toLowerCase()]
    if (rank !== undefined && rank < bestRank) {
      bestRank = rank
      best = sev.charAt(0).toUpperCase() + sev.slice(1)
    }
  }
  return best
}

const DENY_REASONS = [
  { value: "Out of scope", note: "The target is not covered by the program" },
  { value: "Not reproduced", note: "The agent could not trigger the behavior" },
  { value: "Duplicate", note: "Matches an earlier report" },
  { value: "Insufficient detail", note: "Steps or payload is missing" },
]

function TopBack({ onBack }: { onBack: () => void }) {
  const { colors } = useTheme()
  return (
    <View style={styles.topbar}>
      <Pressable
        onPress={onBack}
        style={({ pressed }) => [styles.glassBtn, { backgroundColor: colors.glass, borderColor: colors["glass-edge"] }, pressed && { opacity: 0.92 }]}
        accessibilityLabel="Back to Case file"
      >
        <Icon name="back" size={24} strokeWidth={2.2} stroke={colors.foreground} />
      </Pressable>
    </View>
  )
}

function FloatingBar({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.fbar, { backgroundColor: colors.glass, borderColor: colors["glass-edge"] }]}>
      {children}
    </View>
  )
}

export default function SignTheVerdictScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { colors, phase } = useTheme()
  const toast = useToast()

  const { data: cf, error, isError, refetch } = useApiQuery<CaseFileWithDelivery>(`/reports/${id}`)

  const [denySheetOpen, setDenySheetOpen] = useState(false)
  const [denyReason, setDenyReason] = useState("Out of scope")
  const [denyNote, setDenyNote] = useState("")
  const [approving, setApproving] = useState(false)
  const [hashMismatch, setHashMismatch] = useState(false)

  const verdict = cf?.verdict
  const contentHash = verdict?.contentHash ?? ""
  const displayHash = contentHash ? `sha256:${contentHash}` : ""
  const outcomeLabel = verdict?.outcomeLabel ?? verdict?.outcome ?? ""
  const severity = useMemo(() => (cf ? maxSeverity(cf) : null), [cf])
  const delivery = useMemo(() => (cf ? deliveryLabel(cf) : ""), [cf])

  // Auth errors are terminal: render nothing rather than a broken shell.
  if (isError && error instanceof ApiError && (error.status === 401 || error.status === 403)) return null

  const handleApprove = useCallback(async () => {
    // Biometric re-confirm: a speed bump for the weighty action of approving.
    const hasHardware = await LocalAuthentication.hasHardwareAsync()
    if (hasHardware) {
      const enrolled = await LocalAuthentication.isEnrolledAsync()
      if (enrolled) {
        const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Approve verdict" })
        if (!result.success) return
      }
    }

    setApproving(true)
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)

    const v = verdict
    if (!v) {
      setApproving(false)
      return
    }

    try {
      // Send the exact contentHash returned by the API with the displayed text.
      // Never recompute or edit it client-side.
      await api<{ ok: boolean }>(`/reports/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdictId: v.id, contentHash }),
      } as any)

      toast.show("Approved. Sending to GitHub")
      setTimeout(() => router.push(`/reports/${id}/verdict-approved`), 1100)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 409 && err.code === "content_hash_mismatch") {
        setHashMismatch(true)
        await refetch()
      } else {
        toast.show("Approve failed")
      }
    } finally {
      setApproving(false)
    }
  }, [router, id, verdict, contentHash, refetch, toast])

  const handleDenyConfirm = useCallback(async () => {
    if (!verdict) return

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)

    try {
      await api(`/reports/${id}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdictId: verdict.id, contentHash, reason: denyReason }),
      } as any)

      setDenySheetOpen(false)
      toast.show("Denied. Nothing was sent")
      setTimeout(() => {
        ;(router as any).popToTop()
        router.replace("/(tabs)")
      }, 1100)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 409 && err.code === "content_hash_mismatch") {
        setHashMismatch(true)
        await refetch()
        setDenySheetOpen(false)
      } else {
        toast.show("Denied failed")
      }
    }
  }, [router, id, verdict, contentHash, denyReason, refetch, toast])

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ToastProvider>
        <TopBack onBack={() => router.back()} />

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          {isError ? (
            <View style={[styles.centered, { backgroundColor: colors.background }]}>
              <Text style={[styles.errorText, { color: colors.red }]}>
                {error?.message ?? "Failed to load case file"}
              </Text>
              <Pressable onPress={() => refetch()} style={styles.retryLink}>
                <Text style={{ color: colors.brand, fontWeight: "600" }}>Retry</Text>
              </Pressable>
            </View>
          ) : !cf || !verdict ? (
            <Text style={[styles.h1, { color: colors.muted }]}>Loading</Text>
          ) : hashMismatch ? (
            <View style={styles.mismatchBox}>
              <Text style={[styles.mismatchTitle, { color: colors.foreground }]}>This verdict changed</Text>
              <Text style={[styles.mismatchBody, { color: colors.muted }]}>
                Refresh and review again.
              </Text>
              <Pressable onPress={() => { setHashMismatch(false); refetch() }} style={[styles.mismatchBtn, { backgroundColor: colors.brand }]}>
                <Text style={{ color: "#ffffff", fontWeight: "600", fontSize: 16 }}>Refresh</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Text style={[styles.h1, { color: colors.foreground }]}>Sign the verdict</Text>
              <Text style={[styles.hmeta, { color: colors.muted }]}>{cf.id} · {cf.title}</Text>

              <View style={styles.sect}>
                <Text style={[styles.shPlain, { color: colors.foreground }]}>Outcome</Text>
                <Card style={styles.cardList}>
                  <Row style={styles.itemNoDivider}>
                    <Text style={[styles.rowT, { color: colors.foreground }]}>Outcome</Text>
                    <PhasePill phase="delivered" label={outcomeLabel} labelStyle={{ color: phase.delivered }} />
                  </Row>
                  {/* Severity and Delivery are shown as key/value rows. Severity uses the
                      red colour from c.css; KvRow has no per-value style prop, so render it inline. */}
                  <View style={[styles.kvRow, { backgroundColor: colors.card, borderBottomColor: colors.line }]}>
                    <Text style={[styles.kvLabel, { color: colors.muted }]}>Severity</Text>
                    <Text style={[styles.kvValue, { color: colors.red, fontWeight: "600" }]}>{severity ?? "Unknown"}</Text>
                  </View>
                  <View style={[styles.kvRow, { backgroundColor: colors.card, borderBottomColor: colors.line }]}>
                    <Text style={[styles.kvLabel, { color: colors.muted }]}>Delivery</Text>
                    <Text style={[styles.kvValue, { color: colors.foreground }]}>{delivery}</Text>
                  </View>
                </Card>
              </View>

              <View style={styles.sect}>
                <Text style={[styles.shPlain, { color: colors.foreground }]}>Drafted comment</Text>
                <Card style={styles.cardNoList}>
                  <Text style={[styles.body, { color: colors.foreground }]} selectable>
                    {verdict.payload}
                  </Text>
                </Card>
                <Text style={[styles.note, { color: colors.muted }]}>
                  This exact text is what gets sent. Editing it creates a new revision that needs a fresh approval.
                </Text>
              </View>

              <View style={styles.sect}>
                <Text style={[styles.shPlain, { color: colors.foreground }]}>Content hash</Text>
                <Card style={styles.cardNoList}>
                  <Mono style={[styles.hash, { color: colors.foreground }] as any}>{displayHash}</Mono>
                </Card>
                <Text style={[styles.note, { color: colors.muted }]}>
                  Approval is bound to this hash. Delivery is refused if the text differs.
                </Text>
              </View>
            </>
          )}
        </ScrollView>

        <FloatingBar>
          <PrimaryButton title="Deny" variant="secondary" onPress={() => setDenySheetOpen(true)} />
          <PrimaryButton title="Approve" onPress={handleApprove} disabled={approving} />
        </FloatingBar>

        <Sheet
          visible={denySheetOpen}
          onClose={() => setDenySheetOpen(false)}
          onConfirm={handleDenyConfirm}
          subtitle={cf ? cf.id + " · " + cf.title : ""}
        >
          {cf ? (
            <View style={{ width: "100%" }}>
              <Text style={[styles.lbl, { color: colors.muted }]}>Reason</Text>
              {DENY_REASONS.map((reason) => (
                <Pressable
                  key={reason.value}
                  onPress={() => setDenyReason(reason.value)}
                  style={[styles.reasonRow, { backgroundColor: colors.card, borderBottomColor: colors.line }]}
                >
                  <View style={styles.reasonMain}>
                    <Text style={[styles.reasonTitle, { color: colors.foreground }]}>{reason.value}</Text>
                    <Text style={[styles.reasonNote, { color: colors.muted }]}>{reason.note}</Text>
                  </View>
                  <View style={[styles.radio, { borderColor: colors.faint }]}>
                    {denyReason === reason.value && (
                      <View style={[styles.radioDot, { backgroundColor: colors.brand }]} />
                    )}
                  </View>
                </Pressable>
              ))}
              <Text style={[styles.lbl, { color: colors.muted }]}>Note to reporter (optional)</Text>
              <TextInput
                style={[styles.textarea, { backgroundColor: colors.raised, borderColor: colors.line, color: colors.foreground }]}
                placeholder="Sent with the denial"
                placeholderTextColor={colors.faint}
                value={denyNote}
                onChangeText={setDenyNote}
                multiline
                textAlignVertical="top"
              />
              <Text style={[styles.note, { color: colors.muted, paddingHorizontal: 4 }]}>
                Nothing is sent to the reporter until you confirm. The report moves to Denied.
              </Text>
            </View>
          ) : null}
        </Sheet>
      </ToastProvider>
    </View>
  )
}

const styles = StyleSheet.create({
  topbar: { position: "absolute", top: 54, left: 16, zIndex: 30 },
  glassBtn: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorText: { fontSize: 16 },
  retryLink: { marginTop: 12 },
  scrollContent: { paddingTop: 100, paddingBottom: 90, marginHorizontal: 20 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.84, marginTop: 8 },
  hmeta: { fontSize: 15, lineHeight: 20, marginTop: 4 },
  sect: { marginBottom: 28 },
  shPlain: { fontSize: 20, fontWeight: "600", lineHeight: 24, marginBottom: 12 },
  cardList: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden" },
  cardNoList: { marginHorizontal: 16, borderRadius: 24, overflow: "hidden", padding: 0 },
  itemNoDivider: { paddingVertical: 10, paddingHorizontal: 18, minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowT: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  body: { padding: 18, fontSize: 17, lineHeight: 23 },
  hash: { padding: 18, fontSize: 13, lineHeight: 20 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 20, paddingTop: 10 },
  fbar: { position: "absolute", left: 16, right: 16, bottom: 30, flexDirection: "row", gap: 6, padding: 6, borderRadius: 36, borderWidth: StyleSheet.hairlineWidth },
  lbl: { fontSize: 13, fontWeight: "600", paddingHorizontal: 4, paddingBottom: 6 },
  reasonRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 64 },
  reasonMain: { flex: 1, minWidth: 0 },
  reasonTitle: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  reasonNote: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  radio: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: "center", justifyContent: "center", flexShrink: 0, marginLeft: 12 },
  radioDot: { width: 14, height: 14, borderRadius: 7 },
  textarea: { width: "100%", minHeight: 92, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: 14, fontSize: 17, lineHeight: 23, textAlignVertical: "top" },
  mismatchBox: { alignItems: "center", paddingVertical: 60 },
  mismatchTitle: { fontSize: 20, fontWeight: "600", lineHeight: 24, marginBottom: 8 },
  mismatchBody: { fontSize: 15, lineHeight: 20, marginBottom: 20 },
  mismatchBtn: { paddingHorizontal: 24, paddingVertical: 14, borderRadius: 26, minWidth: 160, alignItems: "center", justifyContent: "center" },
  kvRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, minHeight: 56, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth },
  kvLabel: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  kvValue: { fontSize: 17, color: "#9CA3AF", textAlign: "right", flexShrink: 1 },
})