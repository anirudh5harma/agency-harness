#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDirectory, "..", "..");
const fixtureRoot = join(projectRoot, "fixtures", "divide");
const builtCli = join(projectRoot, "dist", "cli", "index.js");
const timeoutMs = Number.parseInt(process.env.AGENCY_REAL_PI_TIMEOUT_MS ?? "300000", 10);

function help() {
  process.stdout.write(`Real-Pi divide acceptance\n\nUsage:\n  npm run acceptance:real-pi\n\nBuilds Agency, copies fixtures/divide to a temporary Git repository, installs the\nfixture dependencies, and sends exactly two conversational turns through the normal\nconfigured Pi provider/model. Configure Pi exactly as for ordinary Agency use; this\nscript contains and reads no embedded credentials.\n\nOptional environment:\n  AGENCY_REAL_PI_TIMEOUT_MS  Total Agency subprocess timeout (default: 300000)\n`);
}

async function command(commandName, args, cwd) {
  try {
    return await execFileAsync(commandName, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    throw new Error(`${commandName} ${args.join(" ")} failed\n${stdout}${stderr}`.trim(), {
      cause: error,
    });
  }
}

function runAgency(cwd) {
  const inputs = [
    "Modify src/divide.ts so divide rejects a zero divisor with a generic Error, and add a focused test in test/divide.test.ts. Keep the existing behavior for nonzero divisors.",
    "Replace that generic Error with an exported custom DivisionByZeroError class and update the focused test to assert that exact error type.",
    "/status",
    "/exit",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builtCli], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sentInputs = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      if (!settled) {
        settled = true;
        reject(new Error(`Agency exceeded ${timeoutMs}ms\n${stdout}${stderr}`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2 * 1024 * 1024) child.kill("SIGTERM");
      const prompts = stdout.match(/agency> /g)?.length ?? 0;
      while (sentInputs < prompts && sentInputs < inputs.length) {
        const input = inputs[sentInputs];
        sentInputs += 1;
        if (sentInputs === inputs.length) child.stdin.end(`${input}\n`);
        else child.stdin.write(`${input}\n`);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`Agency exited ${code ?? signal}\n${stdout}${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function requireMatch(value, pattern, message) {
  if (!pattern.test(value)) throw new Error(message);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("AGENCY_REAL_PI_TIMEOUT_MS must be a positive integer");
  }

  const temporaryParent = await mkdtemp(join(tmpdir(), "agency-real-pi-divide-"));
  const fixture = join(temporaryParent, "divide");
  try {
    await command("npm", ["run", "build"], projectRoot);
    await cp(fixtureRoot, fixture, { recursive: true });
    await command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], fixture);
    await command("git", ["init", "-q", "-b", "main"], fixture);
    await command("git", ["config", "user.email", "agency@example.com"], fixture);
    await command("git", ["config", "user.name", "Agency Acceptance"], fixture);
    await command("git", ["add", "."], fixture);
    await command("git", ["commit", "-qm", "fixture baseline"], fixture);

    const result = await runAgency(fixture);
    const source = await readFile(join(fixture, "src", "divide.ts"), "utf8");
    const tests = await readFile(join(fixture, "test", "divide.test.ts"), "utf8");
    const diff = (await command(
      "git",
      ["diff", "--", "src/divide.ts", "test/divide.test.ts"],
      fixture,
    )).stdout;

    requireMatch(source, /export\s+class\s+DivisionByZeroError\s+extends\s+Error/, "custom error class missing");
    requireMatch(source, /throw\s+new\s+DivisionByZeroError\b/, "divide does not throw the custom error");
    if (/throw\s+new\s+Error\b/.test(source)) throw new Error("generic Error throw remains");
    requireMatch(tests, /DivisionByZeroError/, "custom error test missing");
    requireMatch(diff, /DivisionByZeroError/, "expected Git diff missing");
    requireMatch(result.stdout, /Status: completed/, "/status did not report a completed run");
    requireMatch(result.stdout, /Verification: passed/, "/status did not report passed verification");
    if ((result.stdout.match(/Done:/g) ?? []).length !== 2) {
      throw new Error("Agency did not complete exactly two conversational runs");
    }
    if (result.stderr.trim() !== "") throw new Error(`Agency wrote errors:\n${result.stderr}`);

    await command("npm", ["test"], fixture);
    await command("npm", ["run", "typecheck"], fixture);
    process.stdout.write("Real-Pi divide acceptance passed.\n");
  } finally {
    await rm(temporaryParent, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Real-Pi divide acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
