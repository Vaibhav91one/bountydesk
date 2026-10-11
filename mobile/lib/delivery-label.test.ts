import { deliveryLabel } from "./delivery-label"

it("names where the verdict goes before and after a delivery exists", () => {
  // Before a decision: no target, so deliveryChannel decides.
  expect(deliveryLabel("advisory", undefined)).toBe("GitHub security advisory")
  expect(deliveryLabel("email", null)).toBe("Email to reporter")
  expect(deliveryLabel("upload", null)).toBe("Email to reporter")
  expect(deliveryLabel("github", null)).toBe("Comment on GitHub issue")
  // After: the recorded target wins.
  expect(deliveryLabel("github", "github:1867929:issue:42")).toBe("Comment on GitHub issue")
  expect(deliveryLabel("advisory", "github:1867929:advisory:create")).toBe("GitHub security advisory")
  expect(deliveryLabel("email", "reporter@example.com")).toBe("Email to reporter")
  expect(deliveryLabel(null, undefined)).toBe("Unknown")
})
