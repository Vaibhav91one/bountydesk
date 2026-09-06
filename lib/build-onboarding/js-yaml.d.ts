// Minimal types for the one js-yaml function the classifier uses. js-yaml ships no types of its own
// and @types/js-yaml is not installed here; this narrow declaration keeps the import typed. Replace it
// with @types/js-yaml if that dependency is added.
declare module "js-yaml" {
  export function load(input: string): unknown;
  const _default: { load: typeof load };
  export default _default;
}
