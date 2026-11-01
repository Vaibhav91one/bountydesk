import React from "react"
import { render } from "@testing-library/react-native"

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }))

import { EmptyState, LoadingState } from "../primitives"

const H = { includeHiddenElements: true }

describe("LoadingState and EmptyState", () => {
  it("LoadingState shows the mascot, a progressbar and the label", async () => {
    const { getByText, getByRole, getByTestId } = await render(<LoadingState label="Loading case file" />)
    expect(getByText("Loading case file")).toBeTruthy()
    expect(getByRole("progressbar", { name: "Loading case file", ...H })).toBeTruthy()
    expect(getByTestId("mascot-static", H)).toBeTruthy()
  })

  it("EmptyState shows the mascot, heading and body", async () => {
    const { getByText, getByTestId } = await render(<EmptyState mascot="chilling" heading="Nothing needs you" body="All clear." inline />)
    expect(getByText("Nothing needs you")).toBeTruthy()
    expect(getByText("All clear.")).toBeTruthy()
    expect(getByTestId("mascot-static", H)).toBeTruthy()
  })
})
