// Cuenta como prueba un directorio de pruebas o un archivo test/spec de JavaScript o TypeScript.
export function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
}
