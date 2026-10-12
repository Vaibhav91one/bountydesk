import React from "react"
import { render, fireEvent } from "@testing-library/react-native"
import { PopoverMenu } from "@/components/PopoverMenu"

describe("PopoverMenu", () => {
  const anchor = { x: 300, y: 200, width: 44, height: 44 }

  it("renders nothing without an anchor", async () => {
    const { queryByText } = await render(<PopoverMenu anchor={null} items={[{ label: "A", onPress: jest.fn() }]} onClose={jest.fn()} />)
    expect(queryByText("A")).toBeNull()
  })

  it("closes, then runs the item, when an item is pressed", async () => {
    const calls: string[] = []
    const { getByText } = await render(
      <PopoverMenu
        anchor={anchor}
        items={[
          { label: "Sort by newest", onPress: () => calls.push("newest") },
          { label: "Sort by severity", onPress: () => calls.push("severity") },
        ]}
        onClose={() => calls.push("close")}
      />,
    )
    await fireEvent.press(getByText("Sort by severity"))
    expect(calls).toEqual(["close", "severity"])
  })
})
