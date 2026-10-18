export function assertSupportedNodeVersion(version = process.versions.node) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) < 22) {
    throw new Error(`MoonReconcile workbench requires Node.js 22 or newer; received ${version}`);
  }
}
