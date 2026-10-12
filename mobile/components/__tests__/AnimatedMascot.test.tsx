import React from "react"
import { AccessibilityInfo } from "react-native"
import { render, waitFor } from "@testing-library/react-native"

import { AnimatedMascot } from "../AnimatedMascot"

const reduceMotion = (v: boolean) => jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(v)

const H = { includeHiddenElements: true }

describe("AnimatedMascot", () => {
  afterEach(() => jest.restoreAllMocks())

  it("renders only the static image under Reduce Motion", async () => {
    reduceMotion(true)
    const { queryByTestId, getByTestId } = await render(<AnimatedMascot name="greeting" size={200} float />)
    await waitFor(() => expect(AccessibilityInfo.isReduceMotionEnabled).toHaveBeenCalled())
    expect(queryByTestId("webview", H)).toBeNull()
    expect(getByTestId("mascot-static", H)).toBeTruthy()
  })

  it("renders a script-free WebView holding the original svg otherwise", async () => {
    reduceMotion(false)
    const { findByTestId } = await render(<AnimatedMascot name="greeting" size={200} />)
    const wv = await findByTestId("webview", H)
    expect(wv.props.source.html).toContain("<svg")
    expect(wv.props.source.html).toContain("@keyframes")
    expect(wv.props.javaScriptEnabled).toBe(false)
    expect(wv.props.opaque).toBe(false)
  })
})
