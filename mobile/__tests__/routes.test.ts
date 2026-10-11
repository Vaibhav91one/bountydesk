// Every literal path the app navigates to must resolve to a route file under app/, so moving a
// screen cannot leave a link pointing at nothing.
import fs from "fs"
import path from "path"

const root = path.join(__dirname, "..")

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : files(p)
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : []
  })
}

const appDir = path.join(root, "app")
const routes = files(appDir)
  .filter((f) => !path.basename(f).startsWith("_"))
  .map((f) => {
    const r = f.slice(appDir.length, -".tsx".length).replace(/\/\([^)]*\)/g, "").replace(/\/index$/, "")
    return new RegExp("^" + (r || "/").replace(/\[[^\]]+\]/g, "[^/]+") + "$")
  })

function resolves(target: string): boolean {
  const p = target.split("?")[0].replace(/\$\{[^}]+\}/g, "x").replace(/\/\([^)]*\)/g, "") || "/"
  return routes.some((r) => r.test(p))
}

it("every navigation target resolves to a route file", () => {
  const sources = [...files(appDir), ...files(path.join(root, "components"))]
  const dead: string[] = []
  for (const f of sources) {
    const text = fs.readFileSync(f, "utf8")
    const pattern = /(?:push|replace|navigate)\(\s*[`"](\/[^`"]*)[`"]|pathname:\s*[`"](\/[^`"]*)[`"]/g
    for (const m of text.matchAll(pattern)) {
      const target = m[1] ?? m[2]
      if (!resolves(target)) dead.push(`${path.relative(root, f)} -> ${target}`)
    }
  }
  expect(dead).toEqual([])
})
