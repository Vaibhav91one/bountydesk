/**
 * Tests for lib/push. Mocks expo-notifications, expo-device, expo-constants,
 * expo-secure-store and the api client so the registration flow can be
 * asserted against the server contract without any native code.
 */
const mockSetItemAsync = jest.fn().mockResolvedValue(undefined)
const mockGetItemAsync = jest.fn()
const mockDeleteItemAsync = jest.fn().mockResolvedValue(undefined)

jest.mock("expo-secure-store", () => ({
  setItemAsync: (...args: unknown[]) => mockSetItemAsync(...args),
  getItemAsync: (...args: unknown[]) => mockGetItemAsync(...args),
  deleteItemAsync: (...args: unknown[]) => mockDeleteItemAsync(...args),
}))

jest.mock("expo-device", () => ({
  isDevice: true,
}))

const mockPermissionsStatus = "granted"
jest.mock("expo-notifications", () => ({
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDECIDED: "undecided" },
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: mockPermissionsStatus }),
  getExpoPushTokenAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
}))

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: { eas: { projectId: "test-project-id" } },
    },
  },
}))

const mockApi = jest.fn()
jest.mock("./api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
}))

import Constants from "expo-constants"
import * as Notifications from "expo-notifications"
import * as Device from "expo-device"
import { api } from "./api"
import { registerForPush, unregisterPush, routeForNotification } from "./push"

describe("registerForPush", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(Device as typeof Device & { isDevice: boolean }).isDevice = true
    mockPermissionsStatus
    ;(Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: "granted" })
    mockApi.mockResolvedValue(undefined)
    mockGetItemAsync.mockResolvedValue(null)
  })

  it("posts the token with the platform", async () => {
    jest.spyOn(Notifications, "getExpoPushTokenAsync").mockResolvedValue({ data: "ExponentPushToken[abc123]" } as never)

    const result = await registerForPush()

    expect(result).toEqual({ ok: true })
    expect(mockApi).toHaveBeenCalledWith(
      "/push-token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "ExponentPushToken[abc123]", platform: "ios" }),
      }),
    )
    expect(mockSetItemAsync).toHaveBeenCalledWith("bd.pushToken", "ExponentPushToken[abc123]")
  })

  it("returns the physical device reason when isDevice is false", async () => {
    ;(Device as typeof Device & { isDevice: boolean }).isDevice = false

    const result = await registerForPush()

    expect(result).toEqual({ ok: false, reason: "Push needs a physical device" })
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled()
  })

  it("returns the not-set-up reason with no projectId", async () => {
    const original = Constants.expoConfig
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Constants as any).expoConfig = { extra: { eas: {} } }

    const result = await registerForPush()

    expect(result).toEqual({ ok: false, reason: "Push is not set up for this build yet" })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Constants as any).expoConfig = original
  })
})

describe("routeForNotification", () => {
  it("maps the sign screen route", () => {
    expect(routeForNotification({ reportId: "BD-123", screen: "sign" })).toBe(
      "/reports/BD-123/sign-the-verdict",
    )
  })

  it("maps the case screen route", () => {
    expect(routeForNotification({ reportId: "BD-123", screen: "case" })).toBe("/reports/BD-123")
  })

  it("returns null for a reportId containing '/'", () => {
    expect(routeForNotification({ reportId: "BD/123", screen: "case" })).toBeNull()
  })

  it("returns null for a reportId containing '..'", () => {
    expect(routeForNotification({ reportId: "BD..123", screen: "case" })).toBeNull()
  })

  it("returns null for a missing screen", () => {
    expect(routeForNotification({ reportId: "BD-123", screen: "bogus" })).toBeNull()
  })

  it("returns null for non-object data", () => {
    expect(routeForNotification("not-an-object")).toBeNull()
    expect(routeForNotification(null)).toBeNull()
  })
})

describe("unregisterPush", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockApi.mockResolvedValue(undefined)
  })

  it("sends DELETE with the stored token", async () => {
    mockGetItemAsync.mockResolvedValue("ExponentPushToken[old]")

    await unregisterPush()

    expect(mockApi).toHaveBeenCalledWith(
      "/push-token",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ token: "ExponentPushToken[old]" }),
      }),
    )
    expect(mockDeleteItemAsync).toHaveBeenCalledWith("bd.pushToken")
  })

  it("does nothing when no token is stored", async () => {
    mockGetItemAsync.mockResolvedValue(null)

    await unregisterPush()

    expect(mockApi).not.toHaveBeenCalled()
    expect(mockDeleteItemAsync).not.toHaveBeenCalled()
  })

  it("ignores errors from the DELETE and still clears the stored token", async () => {
    mockGetItemAsync.mockResolvedValue("ExponentPushToken[old]")
    mockApi.mockRejectedValueOnce(new Error("network"))

    await unregisterPush()

    expect(mockDeleteItemAsync).toHaveBeenCalledWith("bd.pushToken")
  })
})
