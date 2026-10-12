/** M21 Contact verify. Six-digit code for the submitted report.
 * Matches docs/site/screens/m21.html exactly.
 *
 * Six single-digit boxes (same as M18). On completion, POSTs the code to the public
 * upload verify route. On success, the server-confirmed report id is shown with a
 * delivered mascot. On failure the server's error is shown and the boxes are cleared.
 * Resend uses the verify route's resend form (action=resend, reportId).
 */
import { readError } from "@/lib/api"
import { applyOtpInput } from "@/lib/otp"
import { useState, useRef, useEffect } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, Keyboard } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import { useTheme } from "@/theme"
import { ScreenHeader, ScreenTitle, useToast } from "@/components/primitives"
import { Note } from "@/components/CaseUi"
import { SvgImage } from "@/components/SvgImage"
import { AnimatedMascot } from "@/components/AnimatedMascot"
import { font } from "@/lib/fonts"

const OTP_LENGTH = 6

export default function ContactVerifyScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ email?: string; reportId?: string }>()
  const { colors } = useTheme()
  const { show } = useToast()

  const email = params.email ?? ""
  const reportId = params.reportId ?? ""

  const [code, setCode] = useState("")
  const inputs = useRef<(TextInput | null)[]>([])
  const [verified, setVerified] = useState(false)

  // Focus the first box on mount.
  useEffect(() => {
    inputs.current[0]?.focus()
  }, [])

  const onChangeText = (index: number, value: string) => {
    if (verified) return
    const result = applyOtpInput(code, index, value, OTP_LENGTH)
    setCode(result.code)
    if (result.focus === null) {
      Keyboard.dismiss()
      verifyCode(result.code)
    } else {
      inputs.current[result.focus]?.focus()
    }
  }


  const onKeyPress = (index: number, key: string) => {
    if (key === "Backspace" && !code[index] && index > 0) {
      inputs.current[index - 1]?.focus()
    }
  }

  const verifyCode = async (enteredCode: string) => {
    try {
      const baseURL = process.env.EXPO_PUBLIC_API_BASE
      const response = await fetch(`${baseURL}/api/intake/upload/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId, code: enteredCode }),
      })

      if (!response.ok) {
        const { message } = await readError(response)
        show(message ?? `Verification failed (${response.status})`)
        setCode("")
        inputs.current[0]?.focus()
        return
      }

      const result = await response.json().catch(() => ({}))
      if (result.ok) {
        setVerified(true)
      } else {
        show(result.error || "Verification failed")
        setCode("")
        inputs.current[0]?.focus()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      show(msg.slice(0, 200))
      setCode("")
      inputs.current[0]?.focus()
    }
  }

  const handleResend = async () => {
    try {
      const baseURL = process.env.EXPO_PUBLIC_API_BASE
      const response = await fetch(`${baseURL}/api/intake/upload/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId, action: "resend" }),
      })

      if (!response.ok) {
        const { message } = await readError(response)
        show(message ?? "Could not resend code")
        return
      }

      const result = await response.json().catch(() => ({}))
      if (result.ok) {
        show("Code sent")
      } else {
        show(result.error || "Could not resend code")
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      show(msg.slice(0, 200))
    }
  }

  const getBoxValue = (index: number): string => {
    return code[index] ?? ""
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Submit a report" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        <ScreenTitle title="Verify your contact" meta={`We sent a six digit code to ${email}`} metaBottom={20} />

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
                  maxLength={OTP_LENGTH}
                  textAlign="center"
                  selectTextOnFocus
                  autoComplete="one-time-code"
                  testID={`otp-box-${i}`}
                />
              ))}
            </View>

            <Note center>The code is only valid for this report and expires in 10 minutes.</Note>

            <View style={styles.resendRow}>
              <Pressable onPress={handleResend} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.resendBtn]}>
                <Text style={[styles.resendText, { color: colors["brand-soft"] }]}>Resend code</Text>
              </Pressable>
            </View>

            <Note>An unconfirmed contact is refused. Replies only go to a verified address.</Note>
          </>
        ) : (
          <View style={[styles.successCard, { backgroundColor: colors.card }]}>
            <AnimatedMascot name="delivered" size={140} float style={styles.mascot} />
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
    paddingBottom: 150,
  },
  otp: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  otpBox: {
    width: 48,
    height: 58,
    borderRadius: 16,
    fontFamily: font.semibold, fontSize: 24,
    padding: 0,
  },
  resendRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  resendBtn: {
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
  },
  resendText: {
    fontFamily: font.semibold, fontSize: 17,
    
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
    fontFamily: font.bold, fontSize: 24,
    
    letterSpacing: -0.5,
    lineHeight: 29,
    marginBottom: 8,
  },
  successBody: {
    fontFamily: font.regular, fontSize: 15,
    lineHeight: 23,
    textAlign: "center",
  },
})
