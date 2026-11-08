// i18n helper. Integrator-owned.
// Each feature owns one dictionary file (i18n/<feature>.ts) built with
// defineMessages(): `en` must have exactly the keys of `ja` (missing keys and,
// via the object-literal excess-property check, extra keys are compile errors),
// so translations never silently go missing.
// Keys are namespaced by feature: "hex.title", "issue.start", ...
// Interpolation: "{name}" placeholders, filled from the vars object.

export type Dict = Record<string, string>;

export function defineMessages<const T extends Dict>(m: { ja: T; en: { [K in keyof T]: string } }): {
  ja: T;
  en: { [K in keyof T]: string };
} {
  return m;
}

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
