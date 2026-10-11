module.exports = {
  preset: "jest-expo",
  transformIgnorePatterns: [
    "/node_modules/(?!(expo|@expo|@expo-google-fonts|react-native|@react-native|@react-native-community|react-native-gesture-handler|react-native-reanimated|@clerk|react-native-safe-area-context|react-native-screens|expo-secure-store|expo-modules-core)/)",
  ],
  transform: {
    "^.+\\.svg$": "<rootDir>/jest.svg.js",
  },
  moduleNameMapper: {
    "\\.svg$": "<rootDir>/jest.svg.mock.js",
  },
  testPathIgnorePatterns: ["/node_modules/", "/.expo/"],
}
