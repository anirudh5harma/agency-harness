import { isDeepStrictEqual } from "node:util";

const LOCKFILE_NAMES = new Set([
  "bun.lock", "bun.lockb", "cargo.lock", "composer.lock", "deno.lock", "gemfile.lock",
  "go.sum", "npm-shrinkwrap.json", "package-lock.json", "package.resolved", "packages.lock.json",
  "gradle.lockfile", "mix.lock", "pipfile.lock", "pnpm-lock.yaml", "poetry.lock", "pubspec.lock", "podfile.lock", "uv.lock", "yarn.lock",
]);

const DEPENDENCY_MANIFEST_NAMES = new Set([
  "build.gradle", "build.gradle.kts", "cargo.toml", "composer.json", "gemfile", "go.mod",
  "package.swift", "packages.config", "paket.dependencies", "pipfile", "pom.xml", "pubspec.yaml",
  "pyproject.toml", "settings.gradle", "settings.gradle.kts",
  "conanfile.txt", "mix.exs", "project.toml", "rebar.config", "setup.cfg", "setup.py", "vcpkg.json",
  // Workspace-level dependency topology is dependency policy too.
  "lerna.json", "nx.json", "pnpm-workspace.yaml", "rush.json", "turbo.json", "workspace.json",
  // Central .NET dependency and build manifests.
  "directory.build.props", "directory.build.targets", "directory.packages.props", "global.json",
]);

const PACKAGE_DEPENDENCY_FIELDS = [
  "dependencies", "devDependencies", "peerDependencies", "peerDependenciesMeta",
  "optionalDependencies", "bundledDependencies", "bundleDependencies", "overrides", "resolutions",
] as const;

function policyError(reason: string): Error {
  return new Error(`Agency policy blocks this operation: ${reason}`);
}

function normalizedSegments(path: string): string[] {
  return path.toLowerCase().split("/").filter((segment) => segment !== "" && segment !== ".");
}

export function isLockfilePath(path: string): boolean {
  return LOCKFILE_NAMES.has(normalizedSegments(path).at(-1) ?? "");
}

export function isPackageManifestPath(path: string): boolean {
  return (normalizedSegments(path).at(-1) ?? "") === "package.json";
}

export function isDependencyManifestPath(path: string): boolean {
  const name = normalizedSegments(path).at(-1) ?? "";
  return isPackageManifestPath(path) || DEPENDENCY_MANIFEST_NAMES.has(name) ||
    /^requirements[^/]*\.txt$/u.test(name) ||
    /^environment[^/]*\.yml$/u.test(name) ||
    /\.gemspec$/u.test(name) ||
    /\.(?:csproj|fsproj|vbproj|vcxproj|sln|slnx)$/u.test(name) ||
    /(?:^|\/)gradle\/libs\.versions\.toml$/u.test(path.toLowerCase());
}

export function isMigrationPath(path: string): boolean {
  const segments = normalizedSegments(path);
  if (segments.includes("drizzle")) return true;
  if (segments.some((segment) => /^(?:migrations?|migrate)$/u.test(segment))) return true;
  return segments.some((segment, index) =>
    segment === "versions" && index > 0 && ["alembic", "schema"].includes(segments[index - 1] ?? "")) ||
    segments.some((segment, index) =>
      index > 0 && segment === "versions" && segments.slice(0, index).includes("alembic")) ||
    segments.some((segment, index) => segment === "changelog" && segments[index - 1] === "db") ||
    (segments.at(-2) === "db" && ["schema.rb", "structure.sql"].includes(segments.at(-1) ?? ""));
}

export function assertNeverMutablePath(path: string): void {
  if (isLockfilePath(path)) throw policyError("lockfiles cannot be changed by model tools");
  if (isMigrationPath(path)) throw policyError("migrations cannot be changed by model tools");
  if (isDependencyManifestPath(path) && !isPackageManifestPath(path)) {
    throw policyError("dependency manifests cannot be changed by model tools");
  }
}

function parsePackageManifest(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw policyError("package manifest changes must remain valid JSON with unchanged dependency sections");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw policyError("package manifest must remain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function dependencyPolicyView(manifest: Record<string, unknown>): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const field of PACKAGE_DEPENDENCY_FIELDS) {
    if (Object.hasOwn(manifest, field)) view[field] = manifest[field];
  }
  const pnpm = manifest.pnpm;
  if (typeof pnpm === "object" && pnpm !== null && !Array.isArray(pnpm)) {
    const pnpmPolicy: Record<string, unknown> = {};
    for (const field of ["overrides", "packageExtensions", "peerDependencyRules"] as const) {
      if (Object.hasOwn(pnpm, field)) pnpmPolicy[field] = (pnpm as Record<string, unknown>)[field];
    }
    if (Object.keys(pnpmPolicy).length > 0) view.pnpm = pnpmPolicy;
  }
  return view;
}

export function assertPackageDependencyPolicy(original: string, proposed: string): void {
  const before = dependencyPolicyView(parsePackageManifest(original));
  const after = dependencyPolicyView(parsePackageManifest(proposed));
  if (!isDeepStrictEqual(before, after)) {
    throw policyError("package dependency sections cannot be changed by model tools");
  }
}

export function applyPackageManifestEdits(
  original: string,
  edits: Array<{ oldText: string; newText: string }>,
): string {
  const content = original.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const replacements = edits.map(({ oldText, newText }) => {
    const normalizedOld = oldText.replace(/\r\n?/gu, "\n");
    const first = content.indexOf(normalizedOld);
    if (normalizedOld === "" || first < 0 || content.indexOf(normalizedOld, first + normalizedOld.length) >= 0) {
      throw policyError("package manifest edit targets must be unique and non-empty");
    }
    return { start: first, end: first + normalizedOld.length, newText: newText.replace(/\r\n?/gu, "\n") };
  }).sort((left, right) => left.start - right.start);
  if (replacements.some((replacement, index) => index > 0 && replacement.start < replacements[index - 1]!.end)) {
    throw policyError("package manifest edits cannot overlap");
  }
  let output = "";
  let cursor = 0;
  for (const replacement of replacements) {
    output += content.slice(cursor, replacement.start) + replacement.newText;
    cursor = replacement.end;
  }
  return output + content.slice(cursor);
}
