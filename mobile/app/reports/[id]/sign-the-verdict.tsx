/**
 * M11 Sign the verdict. Shows the agent's drafted outcome, severity, delivery
 * channel, the exact comment text, and its sha256 content hash. Approve runs a
 * biometric re-confirm then POSTs { verdictId, contentHash }, sending back the
 * exact hash returned by the API with the displayed text. Deny opens a sheet
 * over the screen with reason radios and an optional note.
 *
 * Matches docs/site/screens/m11.html pixel for pixel (c.css tokens from theme.ts).
 */
import { useState, useMemo, useCallback, useRef } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import * as LocalAuthentication from "expo-local-authentication"
import * as Haptics from "expo-haptics"

import { deliveryLabel } from "@/lib/delivery-label"
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

// Inner component: calls useToast(), so it must be rendered inside <ToastProvider>.
function SignTheVerdictInner() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { colors, phase } = useTheme()
  const toast = useToast()

  // --- All hooks above every early return (STEP 4) ---
  const { data: cf, error, isError, refetch } = useApiQuery<CaseFileWithDelivery>(`/reports/${id}`)

  const [denySheetOpen, setDenySheetOpen] = useState(false)
  const [denyReason, setDenyReason] = useState("Out of scope")
  const [denyNote, setDenyNote] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [hashMismatch, setHashMismatch] = useState(false)
  const submittingRef = useRef(false)
  const doneRef = useRef(false)

  const verdict = cf?.verdict
  const contentHash = verdict?.contentHash ?? ""
  const displayHash = contentHash ? `sha256:${contentHash}` : ""
  const outcomeLabel = verdict?.outcomeLabel ?? verdict?.outcome ?? ""
  const severity = useMemo(() => (cf ? maxSeverity(cf) : null), [cf])
  const delivery = useMemo(() => (cf ? deliveryLabel(cf.deliveryChannel ?? cf.channel, cf.delivery?.target) : ""), [cf])

  const handleApprove = useCallback(async () => {
    if (!verdict || submitting || submittingRef.current || doneRef.current) return

    // Set submitting immediately to prevent double-tap (STEP 6).
    setSubmitting(true)
    submittingRef.current = true

    // Record the hash the reviewer is looking at right now (STEP 5 + gate rule).
    const recordedVerdictId = verdict.id
    const recordedContentHash = contentHash

    // Biometric re-confirm: a speed bump for the weighty action of approving.
    // The refetch and submit are all inside ONE try/catch/finally (STEP 3).
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync()
      if (hasHardware) {
        const enrolled = await LocalAuthentication.isEnrolledAsync()
        if (enrolled) {
          const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Approve verdict" })
          if (!result.success) {
            return
          }
        }
      }

      // If the verdict changed during the biometric prompt, do NOT submit (STEP 5).
      // react-query v5 refetch() does not throw on a network error; it resolves with
      // isError true. Guard against that so stale data never gets approved.
      const fresh = await refetch()
      if (fresh.isError || fresh.status !== "success") {
        toast.show("Could not confirm the latest verdict. Check your connection and try again.")
        return
      }
      const freshCf = fresh.data as CaseFileWithDelivery | undefined
      if (
        freshCf?.verdict?.id !== recordedVerdictId ||
        freshCf?.verdict?.contentHash !== recordedContentHash
      ) {
        setHashMismatch(true)
        return
      }

      await api<{ ok: boolean }>(`/reports/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdictId: recordedVerdictId, contentHash: recordedContentHash }),
      } as any)

      // 2xx: mark done so the buttons and sheet stay disabled through the
      // navigation delay (STEP 4). finally will not re-enable after success.
      doneRef.current = true
      setSubmitting(false)
      submittingRef.current = false

      // Haptics only after server returns 200 (STEP 8).
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      toast.show("Approved. Sending to GitHub")
      setTimeout(() => router.push(`/reports/${id}/verdict-approved`), 1100)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 409 && err.code === "content_hash_mismatch") {
        setHashMismatch(true)
      } else {
        toast.show("Approve failed")
      }
    } finally {
      // Only re-enable if we did not reach a 2xx (STEP 4).
      if (!doneRef.current) {
        setSubmitting(false)
        submittingRef.current = false
      }
    }
  }, [router, id, verdict, contentHash, refetch, toast])

  const handleDenyConfirm = useCallback(async () => {
    if (!verdict || submitting || submittingRef.current || doneRef.current) return

    // Set submitting immediately to prevent double-tap (STEP 6).
    setSubmitting(true)
    submittingRef.current = true

    // Record the hash the reviewer is looking at right now (STEP 5 + gate rule).
    const recordedVerdictId = verdict.id
    const recordedContentHash = contentHash

    try {
      const fresh = await refetch()
      if (fresh.isError || fresh.status !== "success") {
        toast.show("Could not confirm the latest verdict. Check your connection and try again.")
        return
      }
      const freshCf = fresh.data as CaseFileWithDelivery | undefined
      if (
        freshCf?.verdict?.id !== recordedVerdictId ||
        freshCf?.verdict?.contentHash !== recordedContentHash
      ) {
        setDenySheetOpen(false)
        setHashMismatch(true)
        return
      }

      // Build the reason string from reason + optional note (STEP 7).
      const reason = denyNote.trim() ? `${denyReason}: ${denyNote.trim()}` : denyReason

      await api(`/reports/${id}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdictId: recordedVerdictId, contentHash: recordedContentHash, reason }),
      } as any)

      // 2xx: mark done so the buttons and sheet stay disabled through the
      // navigation delay (STEP 4).
      doneRef.current = true
      setSubmitting(false)
      submittingRef.current = false

      // Haptics only after server returns 200 (STEP 8).
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
      setDenySheetOpen(false)
      toast.show("Denied. Nothing was sent")
      setTimeout(() => {
        ;(router as any).popToTop()
        router.replace("/(tabs)")
      }, 1100)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 409 && err.code === "content_hash_mismatch") {
        setDenySheetOpen(false)
        setHashMismatch(true)
      } else {
        toast.show("Denied failed")
      }
    } finally {
      // Only re-enable if we did not reach a 2xx (STEP 4).
      if (!doneRef.current) {
        setSubmitting(false)
        submittingRef.current = false
      }
    }
  }, [router, id, verdict, contentHash, denyReason, denyNote, refetch, toast])

  const canSubmit = !!verdict && !isError && !hashMismatch && !submitting && !doneRef.current

  // Auth errors are terminal: render nothing rather than a broken shell.
  if (isError && error instanceof ApiError && (error.status === 401 || error.status === 403)) return null

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <TopBack onBack={() => router.back()} />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {isError ? (
          <View style={[styles.centered, { backgroundColor: colors.background }]}>
            <Text style={[styles.errorText, { color: colors.red }]}>
              {error?.message ?? "Failed to load case file"}
            </Text>
            <Pressable onPress={() => refetch()} style={styles.retryLink} hitSlop={8}>
              <Text style={[styles.retryText, { color: colors.brand }]}>Retry</Text>
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
              <Text style={{ color: colors.card, fontWeight: "600", fontSize: 16 }}>Refresh</Text>
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
                {/* Severity and Delivery are shown as key/value rows. Severity uses the red
                    colour from c.css; KvRow has no per-value style prop, so render it inline. */}
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
        <PrimaryButton
          title="Deny"
          variant="secondary"
          onPress={() => setDenySheetOpen(true)}
          disabled={!canSubmit}
        />
        <PrimaryButton
          title="Approve"
          onPress={handleApprove}
          disabled={!canSubmit}
        />
      </FloatingBar>

      <Sheet
        visible={denySheetOpen}
        onClose={() => setDenySheetOpen(false)}
        onConfirm={handleDenyConfirm}
        subtitle={cf ? cf.id + " · " + cf.title : ""}
        confirmDisabled={!canSubmit}
      >
        {cf ? (
          <View style={{ width: "100%" }}>
            <Text style={[styles.lbl, { color: colors.muted }]}>Reason</Text>
            {DENY_REASONS.map((reason) => (
              <Pressable
                key={reason.value}
                onPress={() => setDenyReason(reason.value)}
                disabled={!canSubmit}
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
    </View>
  )
}

export default function SignTheVerdictScreen() {
  return (
    <ToastProvider>
      <SignTheVerdictInner />
    </ToastProvider>
  )
}

const styles = StyleSheet.create({
  topbar: { position: "absolute", top: 54, left: 16, zIndex: 10 },
  glassBtn: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
  fbar: { position: "absolute", bottom: 30, left: 16, right: 16, flexDirection: "row", gap: 12 },
  scrollContent: { paddingTop: 80, paddingBottom: 110, paddingHorizontal: 4 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.84, paddingHorizontal: 16, paddingTop: 12 },
  hmeta: { fontSize: 15, lineHeight: 20, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 },
  sect: { marginBottom: 28, marginHorizontal: 16 },
  shPlain: { fontSize: 20, fontWeight: "600", lineHeight: 24, marginBottom: 12 },
  cardList: { borderRadius: 24, overflow: "hidden" },
  cardNoList: { borderRadius: 24, padding: 18, overflow: "hidden" },
  itemNoDivider: { paddingHorizontal: 18, paddingVertical: 10, minHeight: 56 },
  rowT: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  body: { fontSize: 17, lineHeight: 24 },
  kvRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, minHeight: 56, paddingHorizontal: 18 },
  kvLabel: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  kvValue: { fontSize: 17, textAlign: "right", flexShrink: 1 },
  hash: { paddingVertical: 8, fontSize: 13, lineHeight: 20, fontFamily: "monospace" },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4, paddingTop: 8 },
  centered: { flex: 1, flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  errorText: { fontSize: 16, textAlign: "center", paddingHorizontal: 24 },
  retryLink: { paddingVertical: 6, paddingHorizontal: 12, minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" },
  retryText: { fontSize: 16, fontWeight: "600" },
  mismatchBox: { alignItems: "center", paddingVertical: 60, paddingHorizontal: 24 },
  mismatchTitle: { fontSize: 20, fontWeight: "600", lineHeight: 24, marginBottom: 8 },
  mismatchBody: { fontSize: 15, lineHeight: 20, marginBottom: 20, textAlign: "center" },
  mismatchBtn: { paddingHorizontal: 24, paddingVertical: 14, borderRadius: 26, minWidth: 160, alignItems: "center", justifyContent: "center" },
  lbl: { fontSize: 13, fontWeight: "600", lineHeight: 18, textTransform: "uppercase", letterSpacing: 0.4, paddingBottom: 8 },
  reasonRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  reasonMain: { flex: 1 },
  reasonTitle: { fontSize: 17, fontWeight: "500", lineHeight: 20 },
  reasonNote: { fontSize: 13, lineHeight: 16, paddingTop: 2 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 14, height: 14, borderRadius: 7 },
  textarea: { width: "100%", minHeight: 92, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: 14, fontSize: 17, lineHeight: 23, textAlignVertical: "top" },
})