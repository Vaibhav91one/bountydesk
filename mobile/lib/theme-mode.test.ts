import { Appearance } from "react-native"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { restoreThemeMode, saveThemeMode } from "./theme-mode"

jest.mock("@react-native-async-storage/async-storage", () => {
  const store: Record<string, string> = {}
  return {
    getItem: jest.fn(async (k: string) => store[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v
    }),
  }
})

it("applies and restores the chosen scheme through Appearance", async () => {
  const spy = jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {})
  await saveThemeMode("dark")
  expect(spy).toHaveBeenLastCalledWith("dark")
  expect(await restoreThemeMode()).toBe("dark")
  await saveThemeMode("system")
  expect(spy).toHaveBeenLastCalledWith("unspecified")
  expect(AsyncStorage.setItem).toHaveBeenLastCalledWith("bd.themeMode", "system")
})
