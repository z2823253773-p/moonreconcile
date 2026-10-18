import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CliError } from "./io.mjs";

// These are path values only. Filesystem selection is deferred until a CLI
// command actually needs the engine, so import, --help, and --version stay
// independent of a build tree.
const PACKAGED_RUNTIME_DIR = fileURLToPath(new URL("../runtime/", import.meta.url));
const PACKAGED_BRIDGE = fileURLToPath(new URL("../runtime/bridge.js", import.meta.url));
const DEVELOPMENT_BRIDGE = fileURLToPath(
  new URL("../_build/js/debug/build/cmd/bridge/bridge.js", import.meta.url),
);

export function bridgeModulePath(modulePath) {
  if (modulePath !== undefined && modulePath !== null) return modulePath;
  // A package owns the runtime directory. If its bridge was removed or is
  // corrupt, importing it must fail instead of reaching a nearby dev build.
  if (existsSync(PACKAGED_RUNTIME_DIR)) return PACKAGED_BRIDGE;
  return DEVELOPMENT_BRIDGE;
}

export async function loadBridgeInvoke(modulePath) {
  const resolvedPath = bridgeModulePath(modulePath);
  let module;
  try {
    module = await import(pathToFileURL(resolvedPath).href);
  } catch (error) {
    const hint = resolvedPath === DEVELOPMENT_BRIDGE ? "; run npm run build in the source checkout" : "";
    throw new CliError(
      "bridge_unavailable",
      `the MoonBit bridge could not be loaded from ${resolvedPath}${hint} (${error.message})`,
    );
  }
  if (typeof module.invoke_bridge !== "function") {
    throw new CliError(
      "bridge_unavailable",
      `the MoonBit bridge at ${resolvedPath} does not export invoke_bridge`,
    );
  }
  return module.invoke_bridge;
}
