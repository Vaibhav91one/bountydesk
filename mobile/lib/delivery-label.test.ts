import { deliveryLabel } from "./delivery-label"

it("names the channel from the delivery target, then the intake channel", () => {
  expect(deliveryLabel("github", "github:1867929:issue:42")).toBe("Comment on GitHub issue")
  expect(deliveryLabel("email", "github:1867929:advisory:create")).toBe("Update security advisory")
  expect(deliveryLabel("email", "reporter@example.com")).toBe("Email to reporter")
  expect(deliveryLabel("github", null)).toBe("Comment on GitHub issue")
  expect(deliveryLabel("", undefined)).toBe("Unknown")
})
