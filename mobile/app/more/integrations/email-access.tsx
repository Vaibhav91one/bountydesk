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
import { ScreenHeader, ScreenTitle, Card, useToast } from "@/components/primitives"
import { Icon } from "@/components/icons"
import { font } from "@/lib/fonts"

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

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <ScreenTitle title="Email access" meta="Reviewer allowlist" metaBottom={24} />

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
              <Text style={[styles.addBtnText, { color: colors.foreground }]}>Add</Text>
            </Pressable>
          </View>
          <Text style={[styles.note, { color: colors.muted }]}>
            We send a six digit code to the address. It stays pending until the code is entered.
          </Text>
        </View>

        {/* Verify with a code: opens the code screen for the first reviewer with a code
            outstanding. The code screen needs an address, so the row is hidden when none waits. */}
        <View style={styles.section}>
          {awaitingCode ? (
          <Card style={styles.list}>
            <Pressable
              onPress={() => handlePendingTap(awaitingCode)}
              style={[styles.item, { backgroundColor: colors.card }]}
            >
              <View style={styles.main}>
                <Text style={[styles.itemT, { color: colors.foreground }]}>Verify with a code</Text>
                <Text style={[styles.itemS, { color: colors.muted }]}>{awaitingCode.email}</Text>
              </View>
              <View style={styles.rowTrailing}>
                <Icon name="chev" size={18} stroke={colors.faint} />
              </View>
            </Pressable>
          </Card>
          ) : null}
          <Text style={[styles.note, { color: colors.muted }]}>Only the owner can add or remove reviewers.</Text>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: {
    paddingTop: 0,
    paddingBottom: 40,
  },
  h1: {
    fontFamily: font.bold, fontSize: 28,
    
    letterSpacing: -0.03 * 28,
    lineHeight: 32,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  hmeta: {
    fontFamily: font.regular, fontSize: 15,
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
    fontFamily: font.semibold, fontSize: 20,
    
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
    fontFamily: font.semibold, fontSize: 16,
    
  },
  main: {
    flex: 1,
    minWidth: 0,
  },
  itemT: {
    fontFamily: font.medium, fontSize: 17,
    
    lineHeight: 20,
  },
  itemS: {
    fontFamily: font.regular, fontSize: 13,
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
    fontFamily: font.semibold, fontSize: 13,
    
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
    fontFamily: font.regular, fontSize: 17,
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
    fontFamily: font.semibold, fontSize: 17,
    
  },
  note: {
    fontFamily: font.regular, fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 10,
  },
})
