import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "videos/**",
    // Vendored from upstream and kept byte-for-byte (see its VENDORED.md). It is CommonJS, so our
    // TypeScript rules reject its require() calls; rewriting it to pass them would quietly fork it.
    "skills/security-audit/**",
    // A static documentation site opened from disk, not part of the app. Its scripts are plain
    // browser globals with no build step, so the app's lint rules do not apply to them.
    "docs/site/**",
  ]),
]);

export default eslintConfig;
