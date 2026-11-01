/** M17 Email access. Reviewer allowlist for email intake.
 * Matches docs/site/screens/m17.html exactly.
 *
 * Reviewers list: shows each email with a role label (Owner / Verified / Pending)
 * and a status pill. Tapping a pending reviewer opens the OTP screen (M18).
 * Only an owner can add reviewers -- the Add button is disabled otherwise.
 * The Add field validates email shape and shows a toast on invalid input.
 */
import { useState, useRef } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput } from "react-native"
import { useRouter } from "expo-router"
import { useApiQuery, useApiMutation, ApiError } from "@/lib/use-query"
import type { EmailReviewer, MobileMe } from "@/lib/types"
import { useTheme } from "@/theme"
import { ScreenHeader, ScreenTitle, PhasePill, useToast, EmptyState, LoadingState } from "@/components/primitives"
import { ListCard, SectionHead } from "@/components/ReportList"
import { BottomFade, ItemLine, Note } from "@/components/CaseUi"
import { ageText } from "@/lib/age"
import { Icon } from "@/components/icons"
import { font } from "@/lib/fonts"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// c.css/m17 subtitles: "Owner", "Verified 3 Oct", "Code sent 4 min ago". createdAt is when the
// reviewer row was made, which is the closest the API gets to when the code went out.
function reviewerSubtitle(reviewer: EmailReviewer): string {
  if (reviewer.role === "owner") return "Owner"
  const at = reviewer.createdAt ? new Date(reviewer.createdAt) : null
  if (reviewer.verified) return at ? `Verified ${at.getDate()} ${MONTHS[at.getMonth()]}` : "Verified"
  return reviewer.codeOutstanding && reviewer.createdAt ? `Code sent ${ageText(reviewer.createdAt, true)}` : "Pending"
}

function reviewerInitials(email: string): string {
  return email.charAt(0).toUpperCase()
}

export default function EmailAccessScreen() {
  const { colors } = useTheme()
  const router = useRouter()
  const { show } = useToast()
  const reviewers = useApiQuery<EmailReviewer[]>("/integrations/email")
  const me = useApiQuery<MobileMe>("/me")
  const [newEmail, setNewEmail] = useState("")
  const pendingEmail = useRef<string>("")

  const addMutation = useApiMutation<{ ok: boolean; codeSent?: boolean; message?: string } & Record<string, unknown>>(
    "/integrations/email",
    {
      onSuccess: (data) => {
        if (data?.ok && data?.codeSent) {
          show(`Code sent to ${pendingEmail.current}`)
          router.push({ pathname: "/more/integrations/otp-verify", params: { email: pendingEmail.current } })
          setNewEmail("")
          pendingEmail.current = ""
        } else if (data?.ok && data?.message) {
          show(data.message)
          setNewEmail("")
          pendingEmail.current = ""
        }
      },
      onError: (error) => {
        const msg = error instanceof Error ? error.message : "Could not add that address"
        show(msg.slice(0, 200))
      },
    }
  )

  const isAuthError =
    (reviewers.error instanceof ApiError && (reviewers.error.status === 401 || reviewers.error.status === 403)) ||
    (me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403))

  if (isAuthError) return null

  const isOwner = me.data?.allowlisted === true && me.data?.role === "owner"

  const handleAddReviewer = () => {
    const email = newEmail.trim()
    if (!email) {
      show("Enter a valid email")
      return
    }
    pendingEmail.current = email
    addMutation.mutate({ email })
  }

  const awaitingCode = reviewers.data?.find((r) => !r.verified && r.codeOutstanding) ?? null

  const handlePendingTap = (reviewer: EmailReviewer) => {
    router.push({ pathname: "/more/integrations/otp-verify", params: { email: reviewer.email } })
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Integrations" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <ScreenTitle title="Email access" meta="Reviewer allowlist" metaBottom={24} />

        {/* 27 not 28: three 61.8pt rows round up to the pixel grid by about a point, which this takes back. */}
        <View style={[styles.sect, { marginBottom: 27 }]}>
          <SectionHead title="Reviewers" />
          {reviewers.isLoading ? (
            <LoadingState label="Loading reviewers" inline />
          ) : (reviewers.data ?? []).length === 0 ? (
            <EmptyState mascot="greeting" heading="No reviewers yet" body="Add an address below to allow it." inline />
          ) : (
          <ListCard>
            {(reviewers.data ?? []).map((reviewer, i) => (
              <Pressable key={reviewer.email} disabled={reviewer.verified} onPress={() => handlePendingTap(reviewer)}>
                <ItemLine
                  divider={i > 0}
                  title={reviewer.email}
                  subtitle={reviewerSubtitle(reviewer)}
                  leading={
                    <View style={[styles.avatar, { backgroundColor: colors.brand + "38" }]}>
                      <Text style={[styles.avatarText, { color: colors["brand-soft"] }]}>{reviewerInitials(reviewer.email)}</Text>
                    </View>
                  }
                  trailing={<PhasePill phase={reviewer.verified ? "delivered" : "approval"} label={reviewer.verified ? "Verified" : "Pending"} />}
                />
              </Pressable>
            ))}
          </ListCard>
          )}
          <Note>Only a verified address can act as a reviewer. Tap a pending address to enter its code.</Note>
        </View>

        <View style={styles.sect}>
          <SectionHead title="Add reviewer" />
          <View style={styles.addRow}>
            <TextInput
              style={[styles.field, { backgroundColor: colors.raised, color: colors.foreground }]}
              placeholder="name@example.com"
              placeholderTextColor={colors.faint}
              accessibilityLabel="Reviewer email"
              value={newEmail}
              onChangeText={setNewEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              textContentType="username"
            />
            <Pressable
              onPress={handleAddReviewer}
              disabled={!isOwner || addMutation.isPending}
              style={[styles.addBtn, { backgroundColor: colors.brand, opacity: !isOwner || addMutation.isPending ? 0.4 : undefined }]}
            >
              <Text style={styles.addBtnText}>Add</Text>
            </Pressable>
          </View>
          <Note>We send a six digit code to the address. It stays pending until the code is entered.</Note>
        </View>

        {/* The code screen needs an address, so the row opens it for the first reviewer with a code outstanding. */}
        <View style={styles.sect}>
          <ListCard>
            <Pressable onPress={() => (awaitingCode ? handlePendingTap(awaitingCode) : show("No address is waiting for a code"))}>
              <ItemLine
                title="Verify with a code"
                subtitle="Open the verification step"
                trailing={<Icon name="chev" size={18} stroke={colors.faint} />}
              />
            </Pressable>
          </ListCard>
          <Note>Only the owner can add or remove reviewers.</Note>
        </View>
      </ScrollView>
      <BottomFade />
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 150 },
  sect: { marginBottom: 28 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  avatarText: { fontFamily: font.semibold, fontSize: 14, lineHeight: 14 },
  addRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16 },
  field: { flex: 1, minWidth: 0, minHeight: 52, borderRadius: 20, paddingHorizontal: 16, fontFamily: font.regular, fontSize: 17, paddingVertical: 0 },
  addBtn: { minHeight: 52, borderRadius: 26, paddingHorizontal: 22, alignItems: "center", justifyContent: "center" },
  addBtnText: { fontFamily: font.semibold, fontSize: 17, lineHeight: 17, color: "#fff" },
})
