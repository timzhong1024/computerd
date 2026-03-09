import { createControlPlane } from "@computerd/control-plane";

async function main() {
  const controlPlane = createControlPlane({
    ...process.env,
    COMPUTERD_METADATA_DIR: process.env.COMPUTERD_METADATA_DIR ?? "/var/lib/computerd/computers",
    COMPUTERD_UNIT_DIR: process.env.COMPUTERD_UNIT_DIR ?? "/etc/systemd/system",
  });

  const name = "example-bash";

  const created = await controlPlane.createComputer({
    name,
    profile: "terminal",
    description: "Minimal bash-backed terminal computer example.",
    lifecycle: {
      autostart: true,
    },
    runtime: {
      execStart: "/usr/bin/bash -i -l",
    },
  });

  console.log("created");
  console.log(JSON.stringify(created, null, 2));

  const started = await controlPlane.startComputer(name);
  console.log("started");
  console.log(JSON.stringify(started, null, 2));

  const detail = await controlPlane.getComputer(name);
  console.log("detail");
  console.log(JSON.stringify(detail, null, 2));

  await controlPlane.stopComputer(name);
  await controlPlane.deleteComputer(name);
  console.log("stopped and deleted");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
