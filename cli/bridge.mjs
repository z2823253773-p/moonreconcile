import { fileURLToPath, pathToFileURL } from "node:url";

import { CliError } from "./io.mjs";

// The pure MoonBit bridge built by `npm run build` into the ignored build tree.
const BRIDGE_MODULE = fileURLToPath(
  new URL("../_build/js/debug/build/cmd/bridge/bridge.js", import.meta.url),
);

export function bridgeModulePath() {
  return BRIDGE_MODULE;
}

// Loads the generated bridge. The host never reimplements engine semantics, so
// a missing or incompatible build is a hard error rather than a fallback.
export async function loadBridgeInvoke(modulePath = BRIDGE_MODULE) {
  let module;
  try {
    module = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new CliError(
      "bridge_unavailable",
      `the MoonBit bridge could not be loaded from ${modulePath}; run npm run build first (${error.message})`,
    );
  }
  if (typeof module.invoke_bridge !== "function") {
    throw new CliError(
      "bridge_unavailable",
      `the MoonBit bridge at ${modulePath} does not export invoke_bridge; run npm run build first`,
    );
  }
  return module.invoke_bridge;
}
