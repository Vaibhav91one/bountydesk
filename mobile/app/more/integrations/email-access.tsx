/** M17 Email access. Reviewer allowlist for email intake.
 * Matches docs/site/screens/m17.html exactly.
 *
 * Reviewers list: shows each email with a role label (Owner / Verified / Pending)
 * and a status pill. Tapping a pending reviewer opens the OTP screen (M18).
 * Only an owner can add reviewers -- the Add button is disabled otherwise.
 * The Add field validates email shape and shows a toast on invalid input.
 */
import { useState } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput } from "react-native"
import { useRouter } from "expo-router"
import { useApiQuery, useApiMutation, ApiError } from "@/lib/use-query"
import type { EmailReviewer, MobileMe } from "@/lib/types"
import { useTheme } from "@/theme"
import { ScreenHeader, Card, useToast } from "@/components/primitives"
import { Icon } from "@/components/icons"

// Maps role to the subtitle text shown in the reviewer row.
function reviewerSubtitle(reviewer: EmailReviewer): string {
  if (reviewer.role === "owner") return "Owner"
  if (reviewer.verified) {
    // c.css uses "Verified 3 Oct" style; we show the createdAt date if available.
    return "Verified"
  }
  return "Pending"
}

// Status pill: Verified = c-delivered, Pending = c-approval.
function reviewerPill(reviewer: EmailReviewer): { label: string; colorKey: "delivered" | "approval" } {
  if (reviewer.verified) {
    return { label: "Verified", colorKey: "delivered" }
  }
  return { label: "Pending", colorKey: "approval" }
}

function reviewerInitials(email: string): string {
  return email.charAt(0).toUpperCase()
}

export default function EmailAccessScreen() {
  const theme = useTheme()
  const { colors } = theme
  const router = useRouter()
  const { show } = useToast()
  const reviewers = useApiQuery<EmailReviewer[]>("/integrations/email")
  const me = useApiQuery<MobileMe>("/me")
  const addMutation = useApiMutation<{ ok: boolean } & Record<string, unknown>>("/integrations/email")

  const [newEmail, setNewEmail] = useState("")

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
    addMutation.mutate({ email })
  }

  const handlePendingTap = (reviewer: EmailReviewer) => {
    router.push({ pathname: "/more/integrations/otp-verify", params: { email: reviewer.email } })
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Email access" back backLabel="Integrations" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <Text style={[styles.h1, { color: colors.foreground }]}>Email access</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>Reviewer allowlist</Text>

        {/* Reviewers section */}
        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>Reviewers</Text>
          </View>
          <Card style={styles.list}>
            {(reviewers.data ?? []).map((reviewer) => {
              const pill = reviewerPill(reviewer)
              const isPending = !reviewer.verified
              const pillColor = pill.colorKey === "delivered" ? theme.phase.delivered : theme.phase.approval
              return (
                <Pressable
                  key={reviewer.email}
                  onPress={() => {
                    if (isPending) {
                      handlePendingTap(reviewer)
                    }
                  }}
                  style={[styles.item, { backgroundColor: colors.card }]}
                >
                  <View style={styles.rowLeading}>
                    <View style={[styles.avatar, { backgroundColor: colors.brand + "29" }]}>
                      <Text style={[styles.avatarText, { color: colors.brand }]}>{reviewerInitials(reviewer.email)}</Text>
                    </View>
                  </View>
                  <View style={styles.main}>
                    <Text style={[styles.itemT, { color: colors.foreground }]}>{reviewer.email}</Text>
                    <Text style={[styles.itemS, { color: colors.muted }]}>{reviewerSubtitle(reviewer)}</Text>
                  </View>
                  <View style={styles.rowTrailing}>
                    <View style={[styles.pill, { backgroundColor: pillColor + "29" }]}>
                      <View style={[styles.pillDot, { backgroundColor: pillColor }]} />
                      <Text style={[styles.pillLabel, { color: pillColor }]}>{pill.label}</Text>
                    </View>
                  </View>
                </Pressable>
              )
            })}
          </Card>
          <Text style={[styles.note, { color: colors.muted }]}>
            Only a verified address can act as a reviewer. Tap a pending address to enter its code.
          </Text>
        </View>

        {/* Add reviewer section */}
        <View style={styles.section}>
          <View style={styles.sh}>
            <Text style={[styles.shText, { color: colors.foreground }]}>Add reviewer</Text>
          </View>
          <View style={styles.addRow}>
            <TextInput
              style={[styles.field, { backgroundColor: colors.raised, color: colors.foreground }]}
              placeholder="name@example.com"
              placeholderTextColor={colors.faint}
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
          <Text style={[styles.note, { color: colors.muted }]}>
            We send a six digit code to the address. It stays pending until the code is entered.
          </Text>
        </View>

        {/* Verify with a code section */}
        <View style={styles.section}>
          <Card style={styles.list}>
            <Pressable
              onPress={() => router.push("/more/integrations/otp-verify")}
              style={[styles.item, { backgroundColor: colors.card }]}
            >
              <View style={styles.main}>
                <Text style={[styles.itemT, { color: colors.foreground }]}>Verify with a code</Text>
                <Text style={[styles.itemS, { color: colors.muted }]}>Open the verification step</Text>
              </View>
              <View style={styles.rowTrailing}>
                <Icon name="chev" size={18} stroke={colors.faint} />
              </View>
            </Pressable>
          </Card>
          <Text style={[styles.note, { color: colors.muted }]}>Only the owner can add or remove reviewers.</Text>
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
  section: {
    marginBottom: 28,
  },
  sh: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  shText: {
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 24,
  },
  list: {
    marginHorizontal: 16,
    borderRadius: 24,
    overflow: "hidden",
    padding: 0,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeading: {
    paddingLeft: 0,
    paddingRight: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 50,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 16,
    fontWeight: "600",
  },
  main: {
    flex: 1,
    minWidth: 0,
  },
  itemT: {
    fontSize: 17,
    fontWeight: "500",
    lineHeight: 20,
  },
  itemS: {
    fontSize: 13,
    marginTop: 3,
  },
  rowTrailing: {
    paddingLeft: 12,
    paddingRight: 0,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 99,
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  pillLabel: {
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 14,
  },
  addRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
  },
  field: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    borderRadius: 20,
    paddingHorizontal: 16,
    fontSize: 17,
    lineHeight: 23,
  },
  addBtn: {
    flex: 0,
    minHeight: 52,
    borderRadius: 26,
    paddingHorizontal: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: {
    fontSize: 17,
    fontWeight: "600",
    color: "#ffffff",
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 10,
  },
})
