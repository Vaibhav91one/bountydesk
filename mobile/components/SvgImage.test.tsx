/**
 * SvgImage must render the transformed <svg> component for an asset name.
 * Guards the regression where metro treated .svg as an asset (so
 * require("...svg").default was undefined and SvgImage returned null).
 */
import React from "react"
import { render } from "@testing-library/react-native"
import { SvgImage } from "@/components/SvgImage"

describe("SvgImage", () => {
  it("renders an svg element for logo-mark", async () => {
    const { toJSON } = await render(<SvgImage name="logo-mark" width={52} height={52} />)
    const json: any = toJSON()
    expect(json).not.toBeNull()
    expect(json.type).toBe("svg")
    expect(json.props.width).toBe(52)
    expect(json.props.height).toBe(52)
  })

  it("warns and returns null for an unknown asset", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {})
    const { toJSON } = await render(<SvgImage name={"nope" as any} width={10} height={10} />)
    expect(toJSON()).toBeNull()
    expect(console.warn).toHaveBeenCalled()
    ;(console.warn as jest.Mock).mockRestore()
  })
})
