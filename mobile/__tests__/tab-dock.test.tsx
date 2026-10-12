import React from "react"
import { render, fireEvent } from "@testing-library/react-native"

import { TabDock } from "@/components/TabDock"

jest.mock("@/components/ReviewFab", () => ({ ReviewFab: () => null }))
jest.mock("@/components/icons", () => ({ Icon: () => null }))
jest.mock("@/theme", () => ({
  useTheme: () => ({ colors: { glass: "#000", "glass-edge": "#111", fill: "#222", foreground: "#fff", muted: "#999" } }),
}))

const routes = ["index", "queue", "reports"].map((name) => ({ key: `${name}-k`, name }))

async function dock(index: number, prevented = false) {
  const navigation = { emit: jest.fn(() => ({ defaultPrevented: prevented })), navigate: jest.fn() }
  const props = { state: { index, routes }, navigation, descriptors: {}, insets: {} } as unknown as React.ComponentProps<typeof TabDock>
  const { getByText } = await render(<TabDock {...props} />)
  return { navigation, getByText }
}

describe("TabDock", () => {
  it("navigates to a tab that is not focused", async () => {
    const { navigation, getByText } = await dock(0)
    await fireEvent.press(getByText("Queue"))
    expect(navigation.navigate).toHaveBeenCalledWith("queue")
  })

  it("does not navigate to the focused tab or when tabPress is prevented", async () => {
    const a = await dock(1)
    await fireEvent.press(a.getByText("Queue"))
    expect(a.navigation.navigate).not.toHaveBeenCalled()
    const b = await dock(0, true)
    await fireEvent.press(b.getByText("Reports"))
    expect(b.navigation.navigate).not.toHaveBeenCalled()
  })
})
