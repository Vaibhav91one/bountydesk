/**
 * Metro config for react-native-svg-transformer.
 * Lets you `import Logo from './logo.svg'` as a React component,
 * matching the inline-SVG look in docs/site/screens/c.js.
 */
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)

config.transformer = {
  ...config.transformer,
  babelTransformerPath: require.resolve("react-native-svg-transformer"),
}

config.resolver = {
  ...config.resolver,
  sourceExts: [...config.resolver.sourceExts.filter((ext) => ext !== "svg"), "svg"],
}

module.exports = config
