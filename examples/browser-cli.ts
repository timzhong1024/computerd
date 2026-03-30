import { runBrowserCli } from "../packages/sdk/src/index";

const exitCode = await runBrowserCli({
  argv: process.argv.slice(2),
});

process.exitCode = exitCode;
