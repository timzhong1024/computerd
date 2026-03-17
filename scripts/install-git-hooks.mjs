import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const hookPath = resolve(process.cwd(), ".git/hooks/pre-push");

try {
  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, "#!/bin/sh\n\nexec node ./scripts/verify-quick.mjs\n", {
    mode: 0o755,
  });
  console.log("Installed pre-push hook");
} catch (error) {
  console.warn(
    `Skipping git hook installation: ${error instanceof Error ? error.message : String(error)}`,
  );
}
