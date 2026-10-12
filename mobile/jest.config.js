module.exports = {
  preset: "jest-expo",
  transformIgnorePatterns: [
    "/node_modules/(?!(expo|@expo|@expo-google-fonts|react-native|@react-native|@react-native-community|react-native-gesture-handler|react-native-reanimated|react-native-worklets|@clerk|react-native-safe-area-context|react-native-screens|expo-[a-z-]+)/)",
  ],
  transform: {
    "^.+\\.svg$": "<rootDir>/jest.svg.js",
  },
  moduleNameMapper: {
    "mascot-png/.*\\.png$": "<rootDir>/jest.asset.mock.js",
    "^react-native-reanimated$": "<rootDir>/jest.reanimated.mock.js",
    "^react-native-webview$": "<rootDir>/jest.webview.mock.js",
    "\\.svg$": "<rootDir>/jest.svg.mock.js",
  },
  testPathIgnorePatterns: ["/node_modules/", "/.expo/"],
}
