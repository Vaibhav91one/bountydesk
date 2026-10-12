// Reanimated needs its native module; tests only need the API shape.
const React = require("react")
const { View } = require("react-native")
module.exports = {
  __esModule: true,
  default: { View: React.forwardRef((p, r) => React.createElement(View, { ref: r, ...p })) },
  Easing: { inOut: () => 0, ease: 0 },
  useSharedValue: (v) => ({ value: v }),
  useAnimatedStyle: () => ({}),
  withRepeat: (v) => v,
  withSequence: (...v) => v[0],
  withTiming: (v) => v,
}
