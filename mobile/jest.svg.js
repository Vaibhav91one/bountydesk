/**
 * Minimal SVG mock for Jest. Returns a pass-through React component
 * so tests can import *.svg files without needing the real svg source.
 * The real SVGs are rendered by react-native-svg-transformer in the app build.
 */
module.exports = {
  process(src, filename) {
    return {
      code: `
        const React = require('react');
        const Svg = () => React.createElement('svg', { width: 24, height: 24, name: ${JSON.stringify(filename)} });
        module.exports = Svg;
        module.exports.default = Svg;
      `,
    }
  },
}
