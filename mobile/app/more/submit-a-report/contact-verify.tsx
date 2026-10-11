/** M21 Contact verify. Six-digit code for the submitted report.
 * Matches docs/site/screens/m21.html exactly.
 *
 * Six single-digit boxes (same as M18). On completion, the success card is shown
 * in place: a delivered mascot, "Report received" heading, and the report id
 * with a reply-to line. Resend code shows a toast "Code sent".
 */
import { useState, useRef, useEffect } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, Keyboard } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import { useTheme } from "@/theme"
import { ScreenHeader, useToast } from "@/components/primitives"
import { SvgImage } from "@/components/SvgImage"

const OTP_LENGTH = 6

export default function ContactVerifyScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ email?: string; reportId?: string }>()
  const { colors } = useTheme()
  const { show } = useToast()

  const email = params.email ?? "you@company.com"
  const reportId = params.reportId ?? "BD-1045"

  const [code, setCode] = useState("")
  const inputs = useRef<(TextInput | null)[]>([])
  const [verified, setVerified] = useState(false)

  // Focus the first box on mount.
  useEffect(() => {
    inputs.current[0]?.focus()
  }, [])

  const onChangeText = (index: number, value: string) => {
    if (verified) return
    const digit = value.replace(/\D/g, "").slice(-1)
    if (!digit) return

    const newCode = code.slice(0, index) + digit + code.slice(index + 1)
    setCode(newCode)

    if (index < OTP_LENGTH - 1) {
      inputs.current[index + 1]?.focus()
    } else {
      // Sixth digit: verify succeeds, show the success card in place.
      Keyboard.dismiss()
      setVerified(true)
    }
  }

  const onKeyPress = (index: number, key: string) => {
    if (key === "Backspace" && !code[index] && index > 0) {
      inputs.current[index - 1]?.focus()
    }
  }

  const handleResend = () => {
    show("Code sent")
  }

  const getBoxValue = (index: number): string => {
    return code[index] ?? ""
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Verify your contact" back backLabel="Submit a report" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Verify your contact</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>We sent a six digit code to {email}</Text>

        {!verified ? (
          <>
            <View style={styles.otp}>
              {Array.from({ length: OTP_LENGTH }).map((_, i) => (
                <TextInput
                  key={i}
                  ref={(el) => {
                    inputs.current[i] = el
                  }}
                  style={[styles.otpBox, { backgroundColor: colors.raised, color: colors.foreground }]}
                  value={getBoxValue(i)}
                  onChangeText={(v) => onChangeText(i, v)}
                  onKeyPress={({ nativeEvent }) => onKeyPress(i, nativeEvent.key)}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  textContentType="oneTimeCode"
                  maxLength={1}
                  textAlign="center"
                  selectTextOnFocus
                />
              ))}
            </View>

            <Text style={[styles.note, { color: colors.muted, textAlign: "center" }]}>
              The code is only valid for this report and expires in 10 minutes.
            </Text>

            <View style={styles.resendRow}>
              <Pressable onPress={handleResend} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.resendBtn]}>
                <Text style={[styles.resendText, { color: colors["brand-soft"] }]}>Resend code</Text>
              </Pressable>
            </View>

            <Text style={[styles.note, { color: colors.muted }]}>
              An unconfirmed contact is refused. Replies only go to a verified address.
            </Text>
          </>
        ) : (
          <View style={[styles.successCard, { backgroundColor: colors.card }]}>
            <SvgImage name="mascot/delivered" width={140} height={140} style={styles.mascot} />
            <Text style={[styles.successTitle, { color: colors.foreground }]}>Report received</Text>
            <Text style={[styles.successBody, { color: colors.muted }]}>
              {reportId} is with the reviewer team. We will reply to {email} once a reviewer approves a response.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: {
    paddingTop: 62,
    paddingBottom: 80,
    alignItems: "center",
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
    paddingBottom: 20,
  },
  otp: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 0,
    paddingBottom: 20,
  },
  otpBox: {
    width: 48,
    height: 58,
    borderRadius: 16,
    fontSize: 24,
    fontWeight: "600",
    lineHeight: 28,
    padding: 0,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 12,
  },
  resendRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  resendBtn: {
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
  },
  resendText: {
    fontSize: 17,
    fontWeight: "600",
  },
  successCard: {
    borderRadius: 24,
    padding: 24,
    alignItems: "center",
    marginHorizontal: 16,
    marginTop: 20,
  },
  mascot: {
    marginBottom: 16,
  },
  successTitle: {
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.5,
    lineHeight: 29,
    marginBottom: 8,
  },
  successBody: {
    fontSize: 15,
    lineHeight: 23,
    textAlign: "center",
  },
})
