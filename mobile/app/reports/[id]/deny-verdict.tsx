/**
 * M13 Deny verdict: a native form sheet over M11 (presentation set in app/_layout.tsx). Cancel and
 * Deny are a button row at the bottom of the sheet. Deny posts the reason and optional note only when pressed,
 * and only if a fresh fetch still holds the verdict M11 showed (its id and hash arrive as params).
 */
import { useState, useCallback, useRef } from "react"
import { View, Text, StyleSheet, Pressable, TextInput } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import * as Haptics from "expo-haptics"

import { useApiQuery, ApiError } from "@/lib/use-query"
import { api } from "@/lib/api"
import { useTheme } from "@/theme"
import { LoadingState, ToastProvider, useToast } from "@/components/primitives"
import { awaitsApproval, type CaseFileWithDelivery } from "@/components/VerdictReview"
import { font } from "@/lib/fonts"

const DENY_REASONS = [
  { value: "Out of scope", note: "The target is not covered by the program" },
  { value: "Not reproduced", note: "The agent could not trigger the behavior" },
  { value: "Duplicate", note: "Matches an earlier report" },
  { value: "Insufficient detail", note: "Steps or payload are missing" },
]

function DenySheet() {
  const router = useRouter()
  const params = useLocalSearchParams<{ id: string; verdictId?: string; contentHash?: string }>()
  const { id } = params
  const { colors } = useTheme()
  const toast = useToast()
  const { data: cf, isError, isLoading, refetch } = useApiQuery<CaseFileWithDelivery>(`/reports/${id}`)

  const [reason, setReason] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [changed, setChanged] = useState(false)
  const submittingRef = useRef(false)
  const doneRef = useRef(false)

  const verdict = cf?.verdict
  // The reviewed verdict: what M11 showed, else what this sheet loaded first.
  const reviewedId = params.verdictId ?? verdict?.id
  const reviewedHash = params.contentHash ?? verdict?.contentHash
  const awaiting = awaitsApproval(cf)
  const canSubmit = !!verdict && awaiting && !isError && !changed && reason != null && !submitting && !doneRef.current

  const submit = useCallback(async () => {
    if (!verdict || !awaiting || !reason || !reviewedId || !reviewedHash) return
    if (submittingRef.current || doneRef.current) return
    setSubmitting(true)
    submittingRef.current = true
    try {
      // react-query v5 refetch() resolves with isError on a network error instead of throwing.
      const fresh = await refetch()
      if (fresh.isError || fresh.status !== "success") {
        toast.show("Could not confirm the latest verdict. Check your connection and try again.")
        return
      }
      const f = fresh.data as CaseFileWithDelivery | undefined
      if (f?.verdict?.id !== reviewedId || f?.verdict?.contentHash !== reviewedHash || !awaitsApproval(f)) {
        setChanged(true)
        return
      }
      const text = note.trim() ? `${reason}: ${note.trim()}` : reason
      await api(`/reports/${id}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdictId: reviewedId, contentHash: reviewedHash, reason: text }),
      } as any)

      doneRef.current = true
      setSubmitting(false)
      submittingRef.current = false
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
      toast.show("Denied. Nothing was sent")
      setTimeout(() => {
        if (router.canDismiss()) router.dismissAll()
        router.replace("/(tabs)")
      }, 1100)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 409 && err.code === "content_hash_mismatch") setChanged(true)
      else toast.show("Denied failed")
    } finally {
      if (!doneRef.current) {
        setSubmitting(false)
        submittingRef.current = false
      }
    }
  }, [router, id, verdict, awaiting, reason, note, reviewedId, reviewedHash, refetch, toast])

  return (
    <View style={styles.root}>
      <Text style={[styles.title, { color: colors.muted }]}>Deny report</Text>
      <Text style={[styles.sub, { color: colors.faint }]}>{cf ? `${cf.sourceLabel} · ${cf.title}` : ""}</Text>

      <View style={styles.body}>
        {changed ? (
          <View style={styles.changed}>
            <Text style={[styles.changedTitle, { color: colors.foreground }]}>This verdict changed</Text>
            <Text style={[styles.changedBody, { color: colors.muted }]}>Refresh and review again.</Text>
          </View>
        ) : isLoading ? (
          <LoadingState label="Loading verdict" inline />
        ) : (
          <>
            <View style={[styles.reasons, { backgroundColor: colors["sheet-card"] }]} accessibilityRole="radiogroup">
              {DENY_REASONS.map((r, i) => {
                const on = reason === r.value
                return (
                  <Pressable key={r.value} onPress={() => setReason(r.value)} disabled={submitting} style={styles.reasonRow}>
                    {i > 0 ? <View style={[styles.divider, { backgroundColor: colors.line }]} /> : null}
                    <View style={styles.reasonMain}>
                      <Text style={[styles.reasonTitle, { color: colors.foreground }]}>{r.value}</Text>
                      <Text style={[styles.reasonNote, { color: colors.muted }]}>{r.note}</Text>
                    </View>
                    <View style={[styles.radio, { borderColor: on ? colors.brand : colors.faint }]}>
                      {on ? <View style={[styles.radioDot, { backgroundColor: colors.brand }]} /> : null}
                    </View>
                  </Pressable>
                )
              })}
            </View>
            <Text style={[styles.lbl, { color: colors.muted }]}>Note to reporter (optional)</Text>
            <TextInput
              style={[styles.textarea, { backgroundColor: colors["sheet-card"], color: colors.foreground }]}
              placeholder="Sent with the denial"
              placeholderTextColor={colors.faint}
              value={note}
              onChangeText={setNote}
              multiline
              textAlignVertical="top"
            />
            <Text style={[styles.footnote, { color: colors.muted }]}>
              Nothing is sent to the reporter until you confirm. The report moves to Denied.
            </Text>
            <View style={styles.actions}>
              <Pressable
                onPress={() => router.back()}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                style={({ pressed }) => [styles.btn, { backgroundColor: colors.fill }, pressed && { opacity: 0.85 }]}
              >
                <Text style={[styles.btnText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={submit}
                disabled={!canSubmit}
                accessibilityRole="button"
                accessibilityLabel="Deny report"
                accessibilityState={{ disabled: !canSubmit }}
                style={({ pressed }) => [styles.btn, { backgroundColor: colors.red }, !canSubmit && { opacity: 0.4 }, pressed && canSubmit && { opacity: 0.85 }]}
              >
                <Text style={[styles.btnText, { color: "#ffffff" }]}>Deny</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </View>
  )
}

export default function DenyVerdictScreen() {
  return (
    <ToastProvider>
      <DenySheet />
    </ToastProvider>
  )
}

const styles = StyleSheet.create({
  root: {},
  title: { fontFamily: font.semibold, fontSize: 17, lineHeight: 20.4, textAlign: "center", paddingTop: 22 },
  sub: { fontFamily: font.regular, fontSize: 13, lineHeight: 17.55, marginTop: 4, marginBottom: 14, textAlign: "center", paddingHorizontal: 20 },
  body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 40 },
  reasons: { borderRadius: 24, paddingVertical: 6, overflow: "hidden" },
  reasonRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingVertical: 10, paddingHorizontal: 18 },
  divider: { position: "absolute", top: 0, left: 18, right: 18, height: 1 },
  reasonMain: { flex: 1, minWidth: 0 },
  reasonTitle: { fontFamily: font.medium, fontSize: 17, lineHeight: 21.25, letterSpacing: -0.187 },
  reasonNote: { fontFamily: font.regular, fontSize: 13, lineHeight: 17.55, marginTop: 3 },
  radio: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 14, height: 14, borderRadius: 7 },
  lbl: { fontFamily: font.semibold, fontSize: 15, lineHeight: 15, paddingTop: 20, paddingBottom: 10, paddingHorizontal: 4 },
  textarea: { height: 92, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 16, fontFamily: font.regular, fontSize: 17, lineHeight: 23.8, textAlignVertical: "top" },
  footnote: { fontFamily: font.regular, fontSize: 13, lineHeight: 18.2, paddingTop: 12, paddingHorizontal: 4 },
  actions: { flexDirection: "row", gap: 10, paddingTop: 20 },
  btn: { flex: 1, minHeight: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  btnText: { fontFamily: font.semibold, fontSize: 17, lineHeight: 17 },
  changed: { alignItems: "center", paddingVertical: 40 },
  changedTitle: { fontFamily: font.semibold, fontSize: 20, lineHeight: 24, marginBottom: 8 },
  changedBody: { fontFamily: font.regular, fontSize: 15, lineHeight: 20, textAlign: "center" },
})
