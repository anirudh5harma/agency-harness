import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

describe("agency CLI", () => {
  it("starts and reports its foundation status", async () => {
    const { stderr, stdout } = await execFileAsync(process.execPath, [cliPath]);

    expect(stderr).toBe("");
    expect(stdout).toBe("Agency CLI foundation ready. Runtime coming next.\n");
  });
});
