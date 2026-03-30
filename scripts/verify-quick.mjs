import { runVerifySteps } from "./run-verify-steps.mjs";

const steps = [
  ["format", ["format:check"]],
  ["lint", ["lint"]],
  ["typecheck", ["typecheck"]],
  ["test", ["test"]],
];

await runVerifySteps({
  label: "verify:quick",
  successMessage: "passed",
  failurePrefix: "verify:quick failed",
  steps,
});
