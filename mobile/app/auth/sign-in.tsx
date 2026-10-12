/** M2 Sign in. Google and GitHub buttons via Clerk useSSO.
 * Matches docs/site/screens/m2.html exactly.
 *
 * Button order (from the HTML source):
 * 1. GitHub  — white pill (background:var(--fg), color:var(--bg)) with GitHub icon
 * 2. Google  — dark pill (.btn.sec, fill background) with Google colored SVG
 * Footer: "Not on the allowlist?" link, legal text with Terms and Privacy links.
 */
import * as AuthSession from "expo-auth-session"
import { useSSO } from "@clerk/expo"
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, useColorScheme } from "react-native"
import Svg, { Path } from "react-native-svg"

import { SvgImage } from "@/components/SvgImage"
import { Icon } from "@/components/icons"
import { darkTheme, lightTheme } from "@/theme"
import { font } from "@/lib/fonts"

// maybeCompleteAuthSession() is called once in app/_layout.tsx at the top
// level so the SSO redirect is resolved before any screen mounts.

const redirectUrl = AuthSession.makeRedirectUri({
  scheme: "bountydesk",
  path: "sso-callback",
})

// The Google G logo colors from m2.html inline SVG
const GOOGLE_COLORS = {
  blue: "#4285F4",
  green: "#34A853",
  yellow: "#FBBC05",
  red: "#EA4335",
}

export default function SignInScreen() {
  const { startSSOFlow } = useSSO()
  const cs = useColorScheme()
  const t = cs === "dark" ? darkTheme : lightTheme

  const handleSSO = async (strategy: "google" | "github") => {
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: `oauth_${strategy}`,
        redirectUrl,
      })
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId })
      }
    } catch (err: any) {
      console.error("Sign in failed:", err.message)
    }
  }

  const GoogleIcon = () => (
    <Svg width={20} height={20} viewBox="0 0 18 18" fill="none">
      <Path
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
        fill={GOOGLE_COLORS.blue}
      />
      <Path
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.7H.96v2.33A9 9 0 009 18z"
        fill={GOOGLE_COLORS.green}
      />
      <Path
        d="M3.96 10.71A5.41 5.41 0 013.68 9c0-.6.1-1.17.28-1.71V4.96H.96A9 9 0 000 9c0 1.45.35 2.83.96 4.04l3-2.33z"
        fill={GOOGLE_COLORS.yellow}
      />
      <Path
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 00.96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"
        fill={GOOGLE_COLORS.red}
      />
    </Svg>
  )

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: t.colors.background }]}
      contentContainerStyle={styles.container}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.hero}>
        {/* m2-hero img: 72x72, border-radius 18, background #121213, padding 10 */}
        <View style={styles.heroImg}>
          <SvgImage name="logo-mark" width={52} height={52} />
        </View>
        {/* h1 style="padding:0;font-size:2rem" -> 32px */}
        <Text style={[styles.title, { color: t.colors.foreground }]}>Sign in to BountyDesk</Text>
        <Text style={[styles.subtitle, { color: t.colors.muted }]}>
          Reviewers only. Your account decides which reports you see.
        </Text>
      </View>

      <View style={styles.btns}>
        {/* GitHub: white pill (background:var(--fg), color:var(--bg)) */}
        <TouchableOpacity
          style={[styles.btn, styles.btnWhite]}
          onPress={() => handleSSO("github")}
          activeOpacity={0.9}
        >
          <Icon name="github" size={20} stroke="#202022" />
          <Text style={[styles.btnTextDark, { color: t.colors.background }]}>Continue with GitHub</Text>
        </TouchableOpacity>

        {/* Google: secondary pill (.btn.sec = fill background, fg text) */}
        <TouchableOpacity
          style={[styles.btn, styles.btnSec, { backgroundColor: t.colors.fill, borderColor: "rgba(255,255,255,0.20)" }]}
          onPress={() => handleSSO("google")}
          activeOpacity={0.9}
        >
          <GoogleIcon />
          <Text style={[styles.btnText, { color: t.colors.foreground }]}>Continue with Google</Text>
        </TouchableOpacity>
      </View>

      {/* m2-quiet link */}
      <TouchableOpacity style={styles.quietLink} onPress={() => {}}>
        <Text style={[styles.quiet, { color: t.colors["brand-soft"] }]}>Not on the allowlist?</Text>
      </TouchableOpacity>

      {/* m2-legal */}
      <Text style={[styles.legal, { color: t.colors.muted }]}>
        By continuing you accept the{" "}
        <Text style={styles.legalLink}>Terms</Text> and the{" "}
        <Text style={styles.legalLink}>Privacy policy</Text>. Sign-in is handled by Clerk.
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    flexDirection: "column",
    paddingHorizontal: 20,
    // m2-wrap: padding: calc(var(--top) + 8px) 20px calc(var(--dockb) + 18px)
    // --top = 62px (status bar + topbar), --dockb = 30px (dock bottom)
    paddingTop: 70,
    paddingBottom: 48,
  },
  hero: {
    flex: 1,
    gap: 14,
    alignItems: "flex-start",
  },
  heroImg: {
    width: 72,
    height: 72,
    borderRadius: 18,
    backgroundColor: "#121213",
    padding: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontFamily: font.bold, fontSize: 32, // 2rem in c.css
    
    letterSpacing: -0.5,
    padding: 0,
  },
  subtitle: {
    fontFamily: font.regular, fontSize: 17, // 1.0625rem
    lineHeight: 24,
    maxWidth: 336,
  },
  btns: {
    gap: 12,
  },
  btn: {
    minHeight: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
    width: "100%",
    flexDirection: "row",
    gap: 8,
  },
  btnWhite: {
    backgroundColor: "#ffffff", // var(--fg) dark = near-white
  },
  btnSec: {
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.20)",
  },
  btnText: {
    fontFamily: font.semibold, fontSize: 17,
    
  },
  btnTextDark: {
    fontFamily: font.semibold, fontSize: 17,
    
  },
  quietLink: {
    marginTop: 6,
    alignSelf: "center",
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  quiet: {
    fontFamily: font.regular, fontSize: 15, // .9375rem
    letterSpacing: 0,
  },
  legal: {
    marginTop: 18,
    alignSelf: "center",
    fontFamily: font.regular, fontSize: 13, // .8125rem
    lineHeight: 20,
    letterSpacing: 0,
  },
  legalLink: {
    textDecorationLine: "underline",
  },
})
