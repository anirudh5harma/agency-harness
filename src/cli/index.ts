#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgencyApplication, type AgencyApplicationDependencies } from "./application.js";
import { ReadlineTerminalIO } from "./repl.js";

export * from "./application.js";
export * from "./commands.js";
export * from "./renderer.js";
export * from "./repl.js";

export async function runAgency(
  dependencies: AgencyApplicationDependencies,
): Promise<void> {
  let application: AgencyApplication | undefined;
  try {
    application = await AgencyApplication.create(dependencies);
    await application.run();
  } finally {
    if (application === undefined) dependencies.io.close();
    else await application.dispose();
  }
}

export async function main(): Promise<void> {
  const io = new ReadlineTerminalIO(process.stdin, process.stdout);
  await runAgency({
    cwd: process.cwd(),
    io,
    output: process.stdout,
    errorOutput: process.stderr,
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Agency could not start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
