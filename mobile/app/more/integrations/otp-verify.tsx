/** M18 OTP verify. Six-box code entry for email verification.
 * Matches docs/site/screens/m18.html exactly.
 *
 * Six single-digit boxes. A digit moves focus on, a paste fills all six.
 * The first box gets textContentType=oneTimeCode and inputMode=numeric.
 * The sixth digit accepts the code, shows "Verified", and pops back to M17.
 * Resend code shows a toast "Code sent".
 */
import { useState, useRef, useEffect } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput, Keyboard } from "react-native"
import { useRouter, useLocalSearchParams } from "expo-router"
import { useTheme } from "@/theme"
import { ScreenHeader, useToast } from "@/components/primitives"

const OTP_LENGTH = 6

export default function OtpVerifyScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ email?: string }>()
  const { colors } = useTheme()
  const { show } = useToast()

  const email = params.email ?? "alex@example.com"
  const [code, setCode] = useState("")
  const inputs = useRef<(TextInput | null)[]>([])

  // Focus the first box on mount.
  useEffect(() => {
    inputs.current[0]?.focus()
  }, [])

  const onChangeText = (index: number, value: string) => {
    // Keep only digits, take the last one.
    const digit = value.replace(/\D/g, "").slice(-1)
    if (!digit) return

    const newCode = code.slice(0, index) + digit + code.slice(index + 1)
    setCode(newCode)

    // Auto-advance to the next box.
    if (index < OTP_LENGTH - 1) {
      inputs.current[index + 1]?.focus()
    } else {
      // Sixth digit: verify succeeds, show toast, pop back.
      Keyboard.dismiss()
      show("Verified")
      setTimeout(() => {
        router.back()
      }, 1000)
    }
  }

  const onKeyPress = (index: number, key: string) => {
    // Backspace on an empty box: go to the previous box.
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
      <ScreenHeader title="Verify your email" back backLabel="Email access" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
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
              textContentType={i === 0 ? "oneTimeCode" : "none"}
              maxLength={1}
              textAlign="center"
              selectTextOnFocus
            />
          ))}
        </View>

        <Text style={[styles.note, { color: colors.muted, textAlign: "center" }]}>
          The code expires in 10 minutes. Verifying makes you an authorized reviewer.
        </Text>
      </ScrollView>

      <View style={styles.resendRow}>
        <Pressable onPress={handleResend} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, styles.resendBtn]}>
          <Text style={[styles.resendText, { color: colors["brand-soft"] }]}>Resend code</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: {
    paddingTop: 62,
    paddingBottom: 80,
    alignItems: "center",
  },
  otp: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 20,
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
    paddingBottom: 30,
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
})
