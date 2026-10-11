import * as SecureStore from "expo-secure-store"
import { TokenCache } from "@clerk/clerk-expo"

/**
 * Token cache backed by expo-secure-store. Tokens are stored in the device keychain
 * / keystore, never in plain AsyncStorage or disk.
 */
export const tokenCache: TokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key)
    } catch {
      return null
    }
  },
  async saveToken(key: string, value: string) {
    try {
      await SecureStore.setItemAsync(key, value)
    } catch {
      // Secure store is unavailable (e.g. web without cookies). Fall through silently;
      // the session will not persist across reloads but auth still works in-session.
    }
  },
}
