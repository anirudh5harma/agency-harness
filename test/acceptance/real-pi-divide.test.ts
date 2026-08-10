import { describe, expect, it } from "vitest";

// The acceptance driver is intentionally executable JavaScript without a declaration file.
// @ts-expect-error importing its exported diagnostic seam is safe for this focused test.
import {
  boundedAgencyDiagnostic,
  postRunDiagnostic,
  validateAgencyTranscript,
} from "../../scripts/acceptance/real-pi-divide.mjs";

describe("real-Pi acceptance diagnostics", () => {
  it("reports all transcript failures in one bounded and sanitized diagnostic", () => {
    const result = {
      stdout: `${"old output\n".repeat(1_000)}Done: first\nStatus: failed\n`,
      stderr: "Authorization: Bearer secret-provider-token\ntoken=secret-value\n",
    };

    let diagnostic = "";
    try {
      validateAgencyTranscript(result);
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }

    expect(diagnostic).toContain("stderr was not empty");
    expect(diagnostic).toContain("expected exactly two completed runs, observed 1");
    expect(diagnostic).toContain("/status reported failed");
    expect(diagnostic).toContain("passed verification missing");
    expect(diagnostic).toContain("Agency transcript (tail):");
    expect(diagnostic).toContain("<redacted>");
    expect(diagnostic).not.toContain("secret-provider-token");
    expect(diagnostic).not.toContain("secret-value");
    expect(diagnostic.length).toBeLessThanOrEqual(8_000);
  });

  it("accepts exactly two completed runs with passed verification", () => {
    expect(() => validateAgencyTranscript({
      stdout: "Done: first\nDone: second\nStatus: completed\nVerification: passed\n",
      stderr: "",
    })).not.toThrow();
  });

  it("adds the bounded transcript to post-run artifact failures", () => {
    const error = postRunDiagnostic(
      new Error("custom error class missing\ntoken=artifact-secret"),
      {
      stdout: "Done: first\nDone: second\nStatus: completed\nVerification: passed\n",
      stderr: "",
      },
    );

    expect(error.message).toContain("Post-run validation failed: custom error class missing");
    expect(error.message).not.toContain("artifact-secret");
    expect(error.message).toContain("[stdout]");
    expect(error.message.length).toBeLessThanOrEqual(8_000);
    expect(boundedAgencyDiagnostic("failure", { stdout: "x".repeat(20_000), stderr: "" }))
      .toHaveLength(8_000);
  });
});
