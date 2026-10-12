/** M18 OTP verify. Six-box code entry for email verification.
 * Matches docs/site/screens/m18.html exactly.
 *
 * Six single-digit boxes. A digit moves focus on, a paste fills all six.
 * The first box gets textContentType=oneTimeCode and inputMode=numeric.
 * The sixth digit accepts the code, POSTs it to the verify route, shows
 * "Verified" on success, and pops back to M17. On failure it shows the
 * server's error and clears the boxes. Resend re-POSTs the add route.
 */
import { applyOtpInput } from "@/lib/otp"
import { useState, useRef, useEffect } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, Keyboard } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import { useTheme } from "@/theme"
import { ScreenHeader, ScreenTitle, useToast } from "@/components/primitives"
import { Note } from "@/components/CaseUi"
import { useApiMutation } from "@/lib/use-query"
import { font } from "@/lib/fonts"

const OTP_LENGTH = 6

export default function OtpVerifyScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ email?: string }>()
  const { colors } = useTheme()
  const { show } = useToast()

  const email = params.email
  // A verify flips the reviewer to verified in GET /integrations/email, which the email-access
  // list and the Integrations count read.
  const verifyMutation = useApiMutation<{ ok: boolean } & Record<string, unknown>>(
    "/integrations/email/verify",
    { invalidate: ["/integrations/email"] },
  )
  const resendMutation = useApiMutation<{ ok: boolean; codeSent?: boolean } & Record<string, unknown>>(
    "/integrations/email"
  )

  const [code, setCode] = useState("")
  const inputs = useRef<(TextInput | null)[]>([])

  // Stable refs so effect deps don't trigger re-runs from context identity changes.
  const showRef = useRef(show)
  showRef.current = show
  const backRef = useRef(router.back)
  backRef.current = router.back

  // No email param: show an error and go back.
  useEffect(() => {
    if (!email) {
      showRef.current("No email address to verify")
      backRef.current()
    }
  }, [email])

  // Focus the first box on mount.
  useEffect(() => {
    if (email) {
      inputs.current[0]?.focus()
    }
  }, [email])

  const onChangeText = (index: number, value: string) => {
    if (verifyMutation.isPending) return
    const result = applyOtpInput(code, index, value, OTP_LENGTH)
    setCode(result.code)
    if (result.focus === null) {
      Keyboard.dismiss()
      verifyMutation.mutate({ email, code: result.code })
    } else {
      inputs.current[result.focus]?.focus()
    }
  }


  const onKeyPress = (index: number, key: string) => {
    // Backspace on an empty box: go to the previous box.
    if (key === "Backspace" && !code[index] && index > 0) {
      inputs.current[index - 1]?.focus()
    }
  }

  const handleResend = () => {
    if (!email) return
    resendMutation.mutate({ email })
  }

  const getBoxValue = (index: number): string => {
    return code[index] ?? ""
  }

  // Show server errors and the success toast, and clear boxes on failure.
  useEffect(() => {
    if (verifyMutation.isError && verifyMutation.error) {
      const msg =
        verifyMutation.error instanceof Error
          ? verifyMutation.error.message
          : "Verification failed"
      showRef.current(msg.slice(0, 200))
      setCode("")
      inputs.current[0]?.focus()
    }
  }, [verifyMutation.isError, verifyMutation.error])

  useEffect(() => {
    if (verifyMutation.isSuccess && verifyMutation.data?.ok) {
      showRef.current("Verified")
      setTimeout(() => {
        backRef.current()
      }, 1000)
    }
  }, [verifyMutation.isSuccess, verifyMutation.data])

  useEffect(() => {
    if (resendMutation.isError && resendMutation.error) {
      const msg =
        resendMutation.error instanceof Error
          ? resendMutation.error.message
          : "Could not resend code"
      showRef.current(msg.slice(0, 200))
    }
  }, [resendMutation.isError, resendMutation.error])

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader back backLabel="Email access" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <ScreenTitle title="Verify your email" meta={`Enter the 6-digit code sent to ${email ?? ""}`} metaBottom={20} />
        <View style={styles.otp}>
          {Array.from({ length: OTP_LENGTH }).map((_, i) => (
            <TextInput
              key={i}
              ref={(el) => {
                inputs.current[i] = el
              }}
              style={[
                styles.otpBox,
                { backgroundColor: colors.raised, color: colors.foreground },
                getBoxValue(i) ? { boxShadow: `0 0 0 1.5px ${colors.faint}` } : null,
              ]}
              value={getBoxValue(i)}
              onChangeText={(v) => onChangeText(i, v)}
              onKeyPress={({ nativeEvent }) => onKeyPress(i, nativeEvent.key)}
              keyboardType="number-pad"
              inputMode="numeric"
              textContentType={i === 0 ? "oneTimeCode" : "none"}
              maxLength={OTP_LENGTH}
              textAlign="center"
              selectTextOnFocus
              autoComplete="one-time-code"
              selectionColor={colors.brand}
              testID={`otp-box-${i}`}
            />
          ))}
        </View>
        <View style={styles.resendRow}>
          <Pressable onPress={handleResend} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.resendBtn]}>
            <Text style={[styles.resendText, { color: colors["brand-soft"] }]}>Resend code</Text>
          </Pressable>
        </View>
        <Note center>The code expires in 10 minutes. Verifying makes you an authorized reviewer.</Note>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 150 },
  otp: { flexDirection: "row", justifyContent: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  otpBox: { width: 48, height: 58, borderRadius: 16, fontFamily: font.semibold, fontSize: 24, lineHeight: 28, padding: 0 },
  resendRow: { paddingTop: 12, paddingHorizontal: 16, alignItems: "center" },
  resendBtn: { minHeight: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", paddingHorizontal: 22 },
  resendText: { fontFamily: font.semibold, fontSize: 17 },
})
