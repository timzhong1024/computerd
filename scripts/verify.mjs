import { runVerifySteps } from "./run-verify-steps.mjs";

const steps = [
  ["format", ["format:check"]],
  ["lint", ["lint"]],
  ["typecheck", ["typecheck"]],
  ["test", ["test"]],
  ["test:e2e", ["test:e2e"]],
  ["build", ["build"]],
];

await runVerifySteps({
  label: "verify",
  successMessage: "all checks passed",
  failurePrefix: "verify failed",
  steps,
});
