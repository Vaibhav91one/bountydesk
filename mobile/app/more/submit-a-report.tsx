/** M20 Submit a report. Public upload form.
 * Matches docs/site/screens/m20.html exactly.
 *
 * Form: Title, Report (multi-line), Your email, Target material picker (sheet
 * with radios: None, Tarball, Dockerfile, Prebuilt image). Submit sends a
 * multipart form to POST /api/intake/upload, then navigates to M21 (contact verify)
 * passing the report id and contact email as params.
 *
 * The upload route is public (no auth), so this screen calls fetch directly rather
 * than useApiMutation, which prefixes the mobile API base path. The route returns
 * { reportId, codeSent } with status 202.
 */
import { useState } from "react"
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput } from "react-native"
import { useRouter } from "expo-router"
import { useTheme } from "@/theme"
import { ScreenHeader, Card, Sheet, useToast } from "@/components/primitives"
import { Icon } from "@/components/icons"
import { ApiError } from "@/lib/use-query"

const TARGET_MATERIALS: { value: string; label: string; subtitle: string }[] = [
  { value: "none", label: "None", subtitle: "Describe the issue in the report only" },
  { value: "tarball", label: "Tarball", subtitle: "Source archive of the application" },
  { value: "dockerfile", label: "Dockerfile", subtitle: "A single file that builds the target" },
  { value: "prebuilt", label: "Prebuilt image", subtitle: "An image pinned by digest" },
]

export default function SubmitReportScreen() {
  const { colors } = useTheme()
  const router = useRouter()
  const { show } = useToast()

  const [title, setTitle] = useState("")
  const [report, setReport] = useState("")
  const [email, setEmail] = useState("")
  const [material, setMaterial] = useState("none")
  const [sheetVisible, setSheetVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    try {
      setSubmitting(true)
      // Build a multipart form to POST /api/intake/upload.
      const formData = new FormData()
      formData.append("title", title)
      formData.append("body", report)
      formData.append("contact", email)
      formData.append("material", material)

      const baseURL = process.env.EXPO_PUBLIC_API_BASE
      const response = await fetch(`${baseURL}/api/intake/upload`, {
        method: "POST",
        body: formData,
      })

      if (!response.ok) {
        const code = response.headers.get("X-Error-Code") ?? undefined
        const body = await response.text().catch(() => "")
        throw new ApiError(response.status, code, body)
      }

      const result = await response.json().catch(() => ({}))
      if (result.ok === false) {
        throw new Error(result.error || "Submit failed")
      }

      // Navigate to contact verify (M21) with the report id and email.
      router.push({
        pathname: "/more/submit-a-report/contact-verify",
        params: { reportId: result.reportId, email },
      })
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        return
      }
      const msg = e instanceof Error ? e.message : String(e)
      show(msg.slice(0, 200))
    } finally {
      setSubmitting(false)
    }
  }

  const selectedMaterial = TARGET_MATERIALS.find((m) => m.value === material) || TARGET_MATERIALS[0]

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Submit a report" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.h1, { color: colors.foreground }]}>Submit a report</Text>
        <Text style={[styles.hmeta, { color: colors.muted }]}>Goes to the reviewer team. No account needed.</Text>

        <View style={styles.form}>
          <View>
            <Text style={[styles.lbl, { color: colors.muted }]}>Title</Text>
            <TextInput
              style={[styles.field, { backgroundColor: colors.raised, color: colors.foreground }]}
              placeholder="Short summary"
              placeholderTextColor={colors.faint}
              value={title}
              onChangeText={setTitle}
            />
          </View>

          <View>
            <Text style={[styles.lbl, { color: colors.muted }]}>Report</Text>
            <TextInput
              style={[styles.field, styles.textarea, { backgroundColor: colors.raised, color: colors.foreground }]}
              placeholder="What happened and how to reproduce it"
              placeholderTextColor={colors.faint}
              value={report}
              onChangeText={setReport}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
            />
          </View>

          <View>
            <Text style={[styles.lbl, { color: colors.muted }]}>Your email</Text>
            <TextInput
              style={[styles.field, { backgroundColor: colors.raised, color: colors.foreground }]}
              placeholder="you@company.com"
              placeholderTextColor={colors.faint}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              textContentType="username"
            />
          </View>

          <View>
            <Text style={[styles.lbl, { color: colors.muted }]}>Target material</Text>
            <Card style={styles.list}>
              <Pressable
                onPress={() => setSheetVisible(true)}
                style={({ pressed }) => [styles.item, { backgroundColor: colors.card }, pressed && { opacity: 0.92 }]}
              >
                <View style={styles.rowLeading}>
                  <Icon name="upload" size={20} stroke={colors["brand-soft"]} />
                </View>
                <View style={styles.main}>
                  <Text style={[styles.itemT, { color: colors.foreground }]}>Add target material</Text>
                  <Text style={[styles.itemS, { color: colors.muted }]}>
                    {selectedMaterial.value === "none" ? "None selected" : selectedMaterial.label}
                  </Text>
                </View>
                <View style={styles.rowTrailing}>
                  <Icon name="chev" size={18} stroke={colors.faint} />
                </View>
              </Pressable>
            </Card>
          </View>
        </View>

        <Text style={[styles.note, { color: colors.muted }]}>
          We email a one-time code to confirm you sent this report. Replies only go to a verified address.
        </Text>

        {/* Target material sheet */}
        <Sheet
          visible={sheetVisible}
          onClose={() => setSheetVisible(false)}
          onConfirm={() => setSheetVisible(false)}
          title="Target material"
          subtitle="Optional. Reviewers build it in an isolated sandbox."
        >
          <View style={styles.sheetContent}>
            {TARGET_MATERIALS.map((m) => (
              <Pressable
                key={m.value}
                onPress={() => setMaterial(m.value)}
                style={[styles.sheetItem, { backgroundColor: colors.card }]}
              >
                <View style={styles.main}>
                  <Text style={[styles.itemT, { color: colors.foreground }]}>{m.label}</Text>
                  <Text style={[styles.itemS, { color: colors.muted }]}>{m.subtitle}</Text>
                </View>
                <View style={styles.rowTrailing}>
                  <View
                    style={[
                      styles.radio,
                      material === m.value && { backgroundColor: colors.brand, borderColor: colors.brand },
                    ]}
                  >
                    {material === m.value && <View style={[styles.radioDot, { backgroundColor: colors.brand }]} />}
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        </Sheet>
      </ScrollView>

      {/* Floating submit bar */}
      <View style={[styles.fbar, { backgroundColor: colors.background }]}>
        <Pressable
          onPress={handleSubmit}
          disabled={submitting || !title || !report || !email}
          style={({ pressed }) => [
            styles.fbarBtn,
            { backgroundColor: colors.brand },
            (submitting || !title || !report || !email) && { opacity: 0.4 },
            pressed && !submitting && { opacity: 0.92 },
          ]}
        >
          <Text style={[styles.fbarBtnText, { color: colors.foreground }]}>Submit report</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: {
    paddingTop: 62,
    paddingBottom: 80,
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
  form: {
    gap: 16,
  },
  lbl: {
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 20,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  field: {
    minHeight: 52,
    borderRadius: 20,
    paddingHorizontal: 16,
    fontSize: 17,
    lineHeight: 23,
    marginHorizontal: 16,
    marginBottom: 4,
  },
  textarea: {
    height: 132,
    minHeight: 132,
    paddingTop: 14,
    paddingBottom: 14,
  },
  list: {
    marginHorizontal: 16,
    borderRadius: 24,
    overflow: "hidden",
    padding: 0,
    marginTop: 4,
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
  sheetContent: {
    paddingBottom: 8,
  },
  sheetItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 64,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  radio: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: "rgba(0,0,0,0.3)",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  radioDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 20,
    marginTop: 12,
  },
  fbar: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 88,
    flexDirection: "row",
    gap: 6,
    padding: 6,
    borderRadius: 36,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fbarBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  fbarBtnText: {
    fontSize: 17,
    fontWeight: "600",
  },
})
