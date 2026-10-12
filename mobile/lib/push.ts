/**
 * Push token registration for the mobile app.
 *
 * The token is read from SecureStore under "bd.pushToken", registered against
 * POST /push-token, and kept there so unregisterPush() can revoke it on sign-out.
 * routeForNotification() turns the data payload of a tapped notification into an
 * in-app route, validating the reportId so a payload cannot inject a path.
 */
import Constants from "expo-constants"
import * as Device from "expo-device"
import * as Notifications from "expo-notifications"
import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"

import { api } from "./api"

const TOKEN_KEY = "bd.pushToken"

export async function registerForPush(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!Device.isDevice) {
    return { ok: false, reason: "Push needs a physical device" }
  }

  const { status } = await Notifications.requestPermissionsAsync()
  if (status !== Notifications.PermissionStatus.GRANTED) {
    return { ok: false, reason: "Notifications are turned off for BountyDesk in Settings" }
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId
  if (!projectId) {
    return { ok: false, reason: "Push is not set up for this build yet" }
  }

  const token = (await Notifications.getExpoPushTokenAsync({ projectId })) as { data: string }
  await api("/push-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: token.data, platform: Platform.OS }),
  })

  await SecureStore.setItemAsync(TOKEN_KEY, token.data)
  return { ok: true }
}

export async function unregisterPush(): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY)
  if (token) {
    try {
      await api("/push-token", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
    } catch {
      // ignore — revocation failure should not block sign-out
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY)
  }
}

export function routeForNotification(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null
  const payload = data as Record<string, unknown>
  const reportId = payload.reportId
  const screen = payload.screen

  if (typeof reportId !== "string") return null
  if (!/^[A-Za-z0-9-]+$/.test(reportId)) return null
  if (screen !== "sign" && screen !== "case") return null

  return screen === "sign"
    ? `/reports/${reportId}/sign-the-verdict`
    : `/reports/${reportId}`
}
