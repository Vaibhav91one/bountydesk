const React = require("react")
const { View } = require("react-native")
module.exports = { WebView: (props) => React.createElement(View, { testID: "webview", ...props }) }
