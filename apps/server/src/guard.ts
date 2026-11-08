import { runGuard } from "./cli/guard.ts";

process.exitCode = await runGuard({
  argv: process.argv.slice(2),
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone entry outside Effect.
  platform: process.platform,
  env: process.env,
});
