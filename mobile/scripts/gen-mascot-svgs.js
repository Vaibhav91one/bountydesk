// Regenerates assets/brand/mascot/index.ts from the .svg files next to it.
const fs = require("fs")
const d = "assets/brand/mascot/"
const names = fs.readdirSync(d).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)).sort()
let o = "// Generated from the sibling .svg files (cd mobile && node scripts/gen-mascot-svgs.js). The WebView renders\n// the original markup so its CSS @keyframes run; react-native-svg cannot.\n"
o += "export type MascotName = " + names.map((n) => JSON.stringify(n)).join(" | ") + "\n\nexport const MASCOT_SVG: Record<MascotName, string> = {\n"
for (const n of names) o += "  " + JSON.stringify(n) + ": " + JSON.stringify(fs.readFileSync(d + n + ".svg", "utf8").trim()) + ",\n"
fs.writeFileSync(d + "index.ts", o + "}\n")
