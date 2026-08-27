import { readFileSync } from "node:fs";

const APP_PATH = new URL("../src/App.tsx", import.meta.url);
const appSource = readFileSync(APP_PATH, "utf8");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

assert(
  appSource.includes("setShowFutureSight(false)") &&
    !appSource.includes("purgeUnreleased") &&
    !appSource.includes("resetUnreleasedSkinSelections"),
  "App delegates Future Sight-off intent without sequencing cleanup policy"
);

const appOwnedExportLifecycle = [
  "requestAnimationFrame",
  "export-image",
  "isExportingRef",
  "exportAttemptRef",
  "setExportStatus",
  "setExportProgress",
  "setExportSnapshot",
  "errorTimer",
];
assert(
  appSource.includes("useExportJob") &&
    appOwnedExportLifecycle.every((name) => !appSource.includes(name)),
  "App delegates export timing, attempts, state, and cleanup to useExportJob"
);

console.log(
  process.exitCode ? "architecture checks failed" : "architecture checks passed"
);
