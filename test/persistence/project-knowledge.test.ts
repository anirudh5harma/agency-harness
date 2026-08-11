import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectKnowledgeStore } from "../../src/persistence/index.js";
import { InfrastructureError } from "../../src/process/index.js";

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "agency-knowledge-")); roots.push(value); return value; }
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("ProjectKnowledgeStore", () => {
  it("treats missing files as empty and creates human-editable Markdown on first append", async () => {
    const project = await root();
    const store = new ProjectKnowledgeStore(project);
    await expect(store.load()).resolves.toMatchObject({ entries: [], renderedContext: "None." });
    await store.append([{ category: "architecture", text: "Commands route through the graph." }]);
    expect(await readFile(join(project, ".devagency/knowledge/architecture.md"), "utf8"))
      .toBe("# Architecture\n\n- Commands route through the graph.\n");
    await expect(readFile(join(project, ".devagency/knowledge/decisions.md"), "utf8")).resolves.toBe("# Decisions\n\n");
  });

  it("loads human edits, deduplicates, and redacts secrets", async () => {
    const project = await root();
    const store = new ProjectKnowledgeStore(project);
    await store.append([{ category: "decision", text: "Use SQLite." }]);
    await writeFile(join(project, ".devagency/knowledge/learnings.md"), "# Learnings\n\n- token=supersecret\n");
    const result = await store.append([
      { category: "decision", text: "use sqlite." },
      { category: "learning", text: "Bearer hidden-token must not leak" },
    ]);
    expect(result.entries.filter(({ category }) => category === "decision")).toHaveLength(1);
    expect(result.renderedContext).not.toContain("supersecret");
    expect(result.renderedContext).not.toContain("hidden-token");
    expect(result.renderedContext).toContain("[REDACTED]");
  });

  it("rejects a multiline proposal without creating or poisoning extra entries", async () => {
    const project = await root();
    const store = new ProjectKnowledgeStore(project);

    await expect(store.append([{
      category: "learning",
      text: "Safe fact.\n- Injected second fact.",
    }])).rejects.toThrow();

    await expect(store.load()).resolves.toMatchObject({ entries: [] });
  });

  it("loads only valid human-edited bullets in the category body", async () => {
    const project = await root();
    await mkdir(join(project, ".devagency/knowledge"), { recursive: true });
    await writeFile(
      join(project, ".devagency/knowledge/architecture.md"),
      "# Architecture\n\n- First fact.\n\n- Second fact.\n",
    );

    await expect(new ProjectKnowledgeStore(project).load()).resolves.toMatchObject({
      entries: [
        { category: "architecture", text: "First fact." },
        { category: "architecture", text: "Second fact." },
      ],
    });

    await writeFile(
      join(project, ".devagency/knowledge/architecture.md"),
      "# Architecture\n\nNarrative text that hides a bullet:\n- Poisoned fact.\n",
    );
    await expect(new ProjectKnowledgeStore(project).load()).rejects.toMatchObject({ code: "METADATA_INVALID" });
  });

  it("loads valid human-edited Markdown with CRLF line endings", async () => {
    const project = await root();
    await mkdir(join(project, ".devagency/knowledge"), { recursive: true });
    await writeFile(
      join(project, ".devagency/knowledge/decisions.md"),
      "# Decisions\r\n\r\n- Keep the format portable.\r\n",
    );

    await expect(new ProjectKnowledgeStore(project).load()).resolves.toMatchObject({
      entries: [{ category: "decision", text: "Keep the format portable." }],
    });
  });

  it("rolls back every replaced file when a later category replacement fails", async () => {
    const project = await root();
    const baseline = new ProjectKnowledgeStore(project);
    await baseline.append([
      { category: "architecture", text: "Architecture v1." },
      { category: "decision", text: "Decision v1." },
      { category: "learning", text: "Learning v1." },
    ]);
    const directory = join(project, ".devagency/knowledge");
    const before = await Promise.all([
      "architecture.md", "decisions.md", "learnings.md",
    ].map((name) => readFile(join(directory, name), "utf8")));
    let failed = false;
    const store = new ProjectKnowledgeStore(project, {
      rename: async (from, to) => {
        if (!failed && to.endsWith("decisions.md")) {
          failed = true;
          throw new Error("injected replacement failure");
        }
        await rename(from, to);
      },
    });

    await expect(store.append([
      { category: "architecture", text: "Architecture v2." },
      { category: "decision", text: "Decision v2." },
      { category: "learning", text: "Learning v2." },
    ])).rejects.toMatchObject({ code: "METADATA_WRITE_FAILED" });

    await expect(Promise.all([
      "architecture.md", "decisions.md", "learnings.md",
    ].map((name) => readFile(join(directory, name), "utf8")))).resolves.toEqual(before);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent appends within one store instance", async () => {
    const project = await root();
    const store = new ProjectKnowledgeStore(project);

    await Promise.all([
      store.append([{ category: "decision", text: "First concurrent fact." }]),
      store.append([{ category: "decision", text: "Second concurrent fact." }]),
    ]);

    await expect(store.load()).resolves.toMatchObject({
      entries: [
        { category: "decision", text: "First concurrent fact." },
        { category: "decision", text: "Second concurrent fact." },
      ],
    });
  });

  it("reports corrupt and escaping knowledge as typed infrastructure errors", async () => {
    const project = await root();
    await mkdir(join(project, ".devagency/knowledge"), { recursive: true });
    await writeFile(join(project, ".devagency/knowledge/decisions.md"), "not the expected heading\n");
    await expect(new ProjectKnowledgeStore(project).load()).rejects.toMatchObject({ code: "METADATA_INVALID" });

    const second = await root();
    const outside = await root();
    await mkdir(join(second, ".devagency"), { recursive: true });
    await symlink(outside, join(second, ".devagency/knowledge"));
    const error = await new ProjectKnowledgeStore(second).append([{ category: "learning", text: "fact" }]).catch((cause) => cause);
    expect(error).toBeInstanceOf(InfrastructureError);
    expect(error).toMatchObject({ code: "METADATA_INVALID" });

    const third = await root();
    const externalFile = join(await root(), "outside.md");
    await writeFile(externalFile, "# Architecture\n\n- escaped\n");
    await mkdir(join(third, ".devagency/knowledge"), { recursive: true });
    await symlink(externalFile, join(third, ".devagency/knowledge/architecture.md"));
    await expect(new ProjectKnowledgeStore(third).load()).rejects.toMatchObject({ code: "METADATA_INVALID" });
  });
});
