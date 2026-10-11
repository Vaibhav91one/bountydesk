/**
 * Jest mock for .svg imports. react-native-svg-transformer turns an SVG file
 * into a default-exported React component; in tests we return a minimal
 * <svg> element so SvgImage (and anything importing an asset) renders
 * something assertable instead of `undefined`.
 */
const React = require("react")
const Svg = (props) => React.createElement("svg", props)
module.exports = Svg
module.exports.default = Svg
