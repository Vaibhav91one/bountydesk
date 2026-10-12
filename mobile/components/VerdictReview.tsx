/**
 * M11 Sign the verdict. Deny opens the deny-verdict route (M13), a native form sheet over this
 * screen, which carries the reviewed verdict id and hash so it can refuse a changed verdict.
 *
 * Approve runs a biometric re-confirm, refetches, and POSTs exactly { verdictId, contentHash } of
 * the verdict that was on screen. The hash is the one the API returned with that text; it is never
 * recomputed here. Approve and Deny are offered only while the report awaits approval.
 */
import { useState, useMemo, useCallback, useRef } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import * as LocalAuthentication from "expo-local-authentication"
import * as Haptics from "expo-haptics"

import { deliveryLabel } from "@/lib/delivery-label"
import { useApiQuery, ApiError } from "@/lib/use-query"
import { api } from "@/lib/api"
import type { MobileCaseFile } from "@/lib/types"
import { useTheme } from "@/theme"
import { GlassBlur } from "@/components/GlassBlur"
import { PhasePill, PrimaryButton, ScreenHeader, ScreenTitle, ToastProvider, useToast } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, ItemLine, KvLine, Note } from "@/components/CaseUi"
import { splitInlineCode } from "@/lib/inline-code"
import { font } from "@/lib/fonts"

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

// The server returns transportReceipt and target on the delivery object (see
// docs/mobile-api.md), but the shared MobileCaseFile type omits them.
export type CaseFileWithDelivery = MobileCaseFile & {
  delivery: {
    state: string
    deliveredAt: string | null
    requiresHumanReview: boolean
    transportReceipt?: string | null
    target?: string | null
  } | null
}

export function maxSeverity(cf: CaseFileWithDelivery): string | null {
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

/** True only while the shown verdict is the one waiting for a human decision. */
export function awaitsApproval(cf: CaseFileWithDelivery | undefined): boolean {
  const v = cf?.verdict
  if (!cf || !v || cf.state !== "AWAITING_APPROVAL" || v.superseded) return false
  return cf.awaitingVerdictId == null || cf.awaitingVerdictId === v.id
}

// Inner component: calls useToast(), so it must be rendered inside <ToastProvider>.
function VerdictReviewInner() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { colors, phase } = useTheme()
  const toast = useToast()

  // --- All hooks above every early return ---
  const { data: cf, error, isError, refetch } = useApiQuery<CaseFileWithDelivery>(`/reports/${id}`)

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
  const awaiting = awaitsApproval(cf)
  const receiptReady = cf?.state === "DELIVERED" || cf?.state === "DELIVERING"
  const segments = useMemo(() => splitInlineCode(verdict?.payload ?? ""), [verdict?.payload])

  const handleApprove = useCallback(async () => {
    if (!verdict || !awaiting || submitting || submittingRef.current || doneRef.current) return

    // Set submitting immediately to prevent double-tap.
    setSubmitting(true)
    submittingRef.current = true

    // Record the hash the reviewer is looking at right now.
    const recordedVerdictId = verdict.id
    const recordedContentHash = contentHash

    try {
      // Biometric re-confirm: a speed bump for the weighty action of approving.
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

      // If the verdict changed during the biometric prompt, do NOT submit. react-query v5
      // refetch() does not throw on a network error; it resolves with isError true.
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

      // 2xx: keep the buttons disabled through the navigation delay.
      doneRef.current = true
      setSubmitting(false)
      submittingRef.current = false

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
      if (!doneRef.current) {
        setSubmitting(false)
        submittingRef.current = false
      }
    }
  }, [router, id, verdict, awaiting, contentHash, refetch, toast, submitting])

  // The sheet gets the verdict this screen shows, so it can refuse to deny a different one.
  const openDeny = useCallback(() => {
    if (!verdict) return
    router.push({ pathname: "/reports/[id]/deny-verdict", params: { id, verdictId: verdict.id, contentHash } } as any)
  }, [router, id, verdict, contentHash])

  const canSubmit = !!verdict && awaiting && !isError && !hashMismatch && !submitting && !doneRef.current

  // Auth errors are terminal: render nothing rather than a broken shell.
  if (isError && error instanceof ApiError && (error.status === 401 || error.status === 403)) return null

  const body = isError ? (
    <View style={styles.centered}>
      <Text style={[styles.errorText, { color: colors.red }]}>{error?.message ?? "Failed to load case file"}</Text>
      <Pressable onPress={() => refetch()} style={styles.retryLink} hitSlop={8}>
        <Text style={[styles.retryText, { color: colors.brand }]}>Retry</Text>
      </Pressable>
    </View>
  ) : !cf || !verdict ? (
    <Text style={[styles.loading, { color: colors.muted }]}>Loading</Text>
  ) : hashMismatch ? (
    <View style={styles.mismatchBox}>
      <Text style={[styles.mismatchTitle, { color: colors.foreground }]}>This verdict changed</Text>
      <Text style={[styles.mismatchBody, { color: colors.muted }]}>Refresh and review again.</Text>
      <Pressable onPress={() => { setHashMismatch(false); refetch() }} style={[styles.mismatchBtn, { backgroundColor: colors.brand }]}>
        <Text style={{ color: "#ffffff", fontFamily: font.semibold, fontSize: 16 }}>Refresh</Text>
      </Pressable>
    </View>
  ) : (
    <>
      <View style={styles.section}>
        <SectionHead title="Outcome" />
        <ListCard>
          <ItemLine title="Outcome" trailing={<PhasePill phase="delivered" label={outcomeLabel} labelStyle={{ color: phase.delivered }} />} />
          <KvLine label="Severity" value={severity ?? "Unknown"} strong divider />
          <KvLine label="Delivery" value={delivery} divider />
        </ListCard>
      </View>

      <View style={styles.section}>
        <SectionHead title="Drafted comment" />
        <ListCard flush>
          <Text style={[styles.body, { color: colors.foreground }]} selectable>
            {segments.map((s, i) =>
              s.code ? (
                <Text key={i} style={[styles.code, { color: colors["brand-soft"] }]}>{s.text}</Text>
              ) : (
                s.text
              ),
            )}
          </Text>
        </ListCard>
        <Note>This exact text is what gets sent. Editing it creates a new revision that needs a fresh approval.</Note>
      </View>

      <View style={styles.section}>
        <SectionHead title="Content hash" />
        <ListCard flush>
          <Text style={[styles.hash, { color: colors.foreground }]}>{displayHash}</Text>
        </ListCard>
        <Note>Approval is bound to this hash. Delivery is refused if the text differs.</Note>
      </View>
    </>
  )

  return (
    <View style={{ flex: 1, backgroundColor: colors.page }}>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <ScreenTitle title="Sign the verdict" meta={cf ? `${cf.sourceLabel} · ${cf.title}` : undefined} metaBottom={24} />
          {body}
        </ScrollView>
        <BottomFade />
        <ScreenHeader back backLabel="Case file" onBack={() => router.back()} />
        {awaiting ? (
          <View style={[styles.fbar, { backgroundColor: colors.glass, borderColor: colors["glass-edge"], overflow: "hidden" }]}><GlassBlur />
            <PrimaryButton title="Deny" variant="secondary" onPress={openDeny} disabled={!canSubmit} style={styles.fbarBtn} />
            <PrimaryButton title="Approve" onPress={handleApprove} disabled={!canSubmit} style={styles.fbarBtn} />
          </View>
        ) : receiptReady ? (
          <View style={[styles.fbar, { backgroundColor: colors.glass, borderColor: colors["glass-edge"], overflow: "hidden" }]}><GlassBlur />
            <PrimaryButton title="View receipt" onPress={() => router.push(`/reports/${id}/verdict-approved`)} style={styles.fbarBtn} />
          </View>
        ) : null}
      </View>

    </View>
  )
}

export function VerdictReview() {
  return (
    <ToastProvider>
      <VerdictReviewInner />
    </ToastProvider>
  )
}

const styles = StyleSheet.create({
  scrollContent: { paddingBottom: 150 },
  section: { marginBottom: 28 },
  body: { fontFamily: font.regular, fontSize: 17, lineHeight: 25.5, letterSpacing: -0.187, paddingTop: 15.3, paddingBottom: 16.7, paddingHorizontal: 18 },
  code: { fontFamily: font.mono, fontSize: 14, letterSpacing: 0 },
  hash: { fontFamily: font.mono, fontSize: 13, lineHeight: 20.15, letterSpacing: 0, paddingVertical: 16, paddingHorizontal: 18 },
  fbar: { position: "absolute", left: 16, right: 16, bottom: 30, flexDirection: "row", alignItems: "center", gap: 6, padding: 6, borderRadius: 36, borderWidth: 1 },
  fbarBtn: { flex: 1 },
  loading: { fontFamily: font.regular, fontSize: 17, textAlign: "center", paddingTop: 40 },
  centered: { alignItems: "center", justifyContent: "center", gap: 12, paddingTop: 40 },
  errorText: { fontFamily: font.regular, fontSize: 16, textAlign: "center", paddingHorizontal: 24 },
  retryLink: { paddingVertical: 6, paddingHorizontal: 12, minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" },
  retryText: { fontFamily: font.semibold, fontSize: 16 },
  mismatchBox: { alignItems: "center", paddingVertical: 60, paddingHorizontal: 24 },
  mismatchTitle: { fontFamily: font.semibold, fontSize: 20, lineHeight: 24, marginBottom: 8 },
  mismatchBody: { fontFamily: font.regular, fontSize: 15, lineHeight: 20, marginBottom: 20, textAlign: "center" },
  mismatchBtn: { paddingHorizontal: 24, paddingVertical: 14, borderRadius: 26, minWidth: 160, alignItems: "center", justifyContent: "center" },
})
