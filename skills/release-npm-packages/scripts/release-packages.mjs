#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RELEASE_TAG_PREFIX = "v";
const QUALITY_GATES = [
  "npm run lint",
  "npm run format:check",
  "npm run typecheck",
  "npm run test -- --coverage",
  "npm run build",
];
const CONVENTIONAL_TYPES = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
]);

/**
 * Exit with an error message.
 * @param {string} message Message to print before exiting.
 * @returns {never}
 */
function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

/**
 * Run a shell command and return stdout.
 * @param {string} command Command to execute.
 * @returns {string}
 */
function run(command) {
  const result = spawnSync(command, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    fail(`Command failed: ${command}${stderr ? `\n${stderr}` : ""}`);
  }

  return (result.stdout ?? "").trim();
}

/**
 * Run a command and stream output.
 * @param {string} command Command to execute.
 */
function runStreaming(command) {
  const result = spawnSync(command, {
    shell: true,
    stdio: "inherit",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    fail(`Command failed: ${command}`);
  }
}

/**
 * Parse semver string.
 * @param {string} version Version string.
 * @returns {{ major: number; minor: number; patch: number }}
 */
function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    fail(`Unsupported semver: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Bump version by type.
 * @param {string} current Current semver.
 * @param {"major" | "minor" | "patch"} bumpType Bump type.
 * @returns {string}
 */
function bumpVersion(current, bumpType) {
  const parsed = parseSemver(current);

  if (bumpType === "major") {
    return `${parsed.major + 1}.0.0`;
  }

  if (bumpType === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/**
 * Ensure working tree is clean.
 */
function assertCleanWorkingTree() {
  const status = run("git status --porcelain");
  if (status !== "") {
    fail("Working tree is not clean. Commit/stash changes before releasing.");
  }
}

/**
 * Resolve package directories under packages/.
 * @returns {string[]}
 */
function getPackageJsonPaths() {
  const packagesDir = path.resolve("packages");
  const entries = readdirSync(packagesDir, { withFileTypes: true });
  const packageJsonPaths = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDir, entry.name, "package.json"))
    .filter((packageJsonPath) => existsSync(packageJsonPath))
    .sort();

  if (packageJsonPaths.length === 0) {
    fail("No package.json files found under packages/.");
  }

  return packageJsonPaths;
}

/**
 * Read a JSON file.
 * @param {string} filePath Path to JSON file.
 * @returns {Record<string, unknown>}
 */
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * Write a JSON file with trailing newline.
 * @param {string} filePath Path to write.
 * @param {Record<string, unknown>} value JSON value.
 */
function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Get the most recent semver tag prefixed with v.
 * @returns {string | null}
 */
function getLastReleaseTag() {
  const tags = run(`git tag --list '${RELEASE_TAG_PREFIX}*' --sort=-v:refname`)
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));

  if (tags.length === 0) {
    return null;
  }

  return tags[0];
}

/**
 * Parse conventional commit metadata.
 * @param {string} subject Commit subject.
 * @param {string} body Commit body.
 * @returns {{ type: string | null; breaking: boolean }}
 */
function parseCommit(subject, body) {
  const match = /^([a-z]+)(\([^)]*\))?(!)?:\s+.+$/.exec(subject);
  const breakingByBody = /BREAKING CHANGE:/m.test(body);

  if (!match) {
    return {
      type: null,
      breaking: breakingByBody,
    };
  }

  const type = match[1];
  const breakingBySubject = match[3] === "!";

  return {
    type: CONVENTIONAL_TYPES.has(type) ? type : null,
    breaking: breakingBySubject || breakingByBody,
  };
}

/**
 * Read commits since the last release tag.
 * @param {string | null} lastTag Last release tag.
 * @returns {Array<{hash: string; subject: string; body: string; type: string | null; breaking: boolean}>}
 */
function getCommitsSince(lastTag) {
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const delimiter = "\x1f";
  const terminator = "\x1e";
  const output = run(
    `git log ${range} --format=%H${delimiter}%s${delimiter}%b${terminator}`,
  );

  const commits = output
    .split(terminator)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [hash, subject, body = ""] = entry.split(delimiter);
      const parsed = parseCommit(subject, body);
      return {
        hash,
        subject,
        body,
        type: parsed.type,
        breaking: parsed.breaking,
      };
    });

  if (commits.length === 0) {
    fail(`No commits found in range ${range}.`);
  }

  return commits;
}

/**
 * Determine the semantic version bump from commits.
 * @param {Array<{type: string | null; breaking: boolean}>} commits Parsed commits.
 * @returns {"major" | "minor" | "patch"}
 */
function determineBumpType(commits) {
  if (commits.some((commit) => commit.breaking)) {
    return "major";
  }

  if (commits.some((commit) => commit.type === "feat")) {
    return "minor";
  }

  if (commits.some((commit) => commit.type !== null)) {
    return "patch";
  }

  fail("No conventional commits found since last release tag.");
}

/**
 * Update workspace dependency versions if they point to oldVersion.
 * @param {Record<string, unknown>} packageJson Package JSON object.
 * @param {Set<string>} workspaceNames Workspace package names.
 * @param {string} oldVersion Old version.
 * @param {string} newVersion New version.
 */
function updateInternalDependencyVersions(
  packageJson,
  workspaceNames,
  oldVersion,
  newVersion,
) {
  const dependencyKeys = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];

  for (const dependencyKey of dependencyKeys) {
    const dependencyMap = packageJson[dependencyKey];
    if (!dependencyMap || typeof dependencyMap !== "object") {
      continue;
    }

    for (const [dependencyName, dependencyVersion] of Object.entries(
      dependencyMap,
    )) {
      if (!workspaceNames.has(dependencyName)) {
        continue;
      }
      if (typeof dependencyVersion !== "string") {
        continue;
      }

      const match = /^(\^|~)?(\d+\.\d+\.\d+)$/.exec(dependencyVersion);
      if (!match) {
        continue;
      }
      if (match[2] !== oldVersion) {
        continue;
      }

      dependencyMap[dependencyName] = `${match[1] ?? ""}${newVersion}`;
    }
  }
}

/**
 * Group commits for changelog output.
 * @param {Array<{subject: string; hash: string; type: string | null; breaking: boolean}>} commits Commits.
 * @returns {{ breaking: string[]; features: string[]; fixes: string[]; others: string[] }}
 */
function groupChangelogEntries(commits) {
  const grouped = {
    breaking: [],
    features: [],
    fixes: [],
    others: [],
  };

  for (const commit of commits) {
    const line = `- ${commit.subject} (${commit.hash.slice(0, 7)})`;

    if (commit.breaking) {
      grouped.breaking.push(line);
      continue;
    }

    if (commit.type === "feat") {
      grouped.features.push(line);
      continue;
    }

    if (commit.type === "fix" || commit.type === "perf") {
      grouped.fixes.push(line);
      continue;
    }

    grouped.others.push(line);
  }

  return grouped;
}

/**
 * Build markdown release notes section.
 * @param {string} version Release version.
 * @param {Array<{subject: string; hash: string; type: string | null; breaking: boolean}>} commits Commits.
 * @returns {string}
 */
function buildReleaseSection(version, commits) {
  const date = new Date().toISOString().slice(0, 10);
  const grouped = groupChangelogEntries(commits);
  const sections = [];

  if (grouped.breaking.length > 0) {
    sections.push(`### Breaking Changes\n${grouped.breaking.join("\n")}`);
  }

  if (grouped.features.length > 0) {
    sections.push(`### Features\n${grouped.features.join("\n")}`);
  }

  if (grouped.fixes.length > 0) {
    sections.push(`### Fixes\n${grouped.fixes.join("\n")}`);
  }

  if (grouped.others.length > 0) {
    sections.push(`### Other\n${grouped.others.join("\n")}`);
  }

  return `## ${RELEASE_TAG_PREFIX}${version} - ${date}\n\n${sections.join("\n\n")}\n`;
}

/**
 * Insert a release section at the top of CHANGELOG.md.
 * @param {string} section Markdown section text.
 */
function updateChangelog(section) {
  const changelogPath = path.resolve("CHANGELOG.md");
  const heading = "# Changelog";

  if (!existsSync(changelogPath)) {
    writeFileSync(changelogPath, `${heading}\n\n${section}\n`, "utf8");
    return;
  }

  const current = readFileSync(changelogPath, "utf8");
  if (!current.startsWith(heading)) {
    fail("CHANGELOG.md exists but does not start with '# Changelog'.");
  }

  const remaining = current.slice(heading.length).trimStart();
  const next = `${heading}\n\n${section}\n${remaining}`.trimEnd() + "\n";
  writeFileSync(changelogPath, next, "utf8");
}

/**
 * Main release entrypoint.
 */
function main() {
  assertCleanWorkingTree();

  for (const qualityGate of QUALITY_GATES) {
    console.log(`[release] Running: ${qualityGate}`);
    runStreaming(qualityGate);
  }

  const packageJsonPaths = getPackageJsonPaths();
  const packageJsons = packageJsonPaths.map((packageJsonPath) => ({
    packageJsonPath,
    packageJson: readJson(packageJsonPath),
  }));

  const versions = new Set(
    packageJsons.map(({ packageJson }) => packageJson.version).filter(Boolean),
  );
  if (versions.size !== 1) {
    fail("Expected all workspace packages to share the same version.");
  }

  const currentVersion = [...versions][0];
  if (typeof currentVersion !== "string") {
    fail("Invalid package version state.");
  }

  const workspaceNames = new Set(
    packageJsons
      .map(({ packageJson }) => packageJson.name)
      .filter((name) => typeof name === "string"),
  );

  const lastTag = getLastReleaseTag();
  const commits = getCommitsSince(lastTag);
  const bumpType = determineBumpType(commits);
  const nextVersion = bumpVersion(currentVersion, bumpType);

  console.log(
    `[release] Bump type: ${bumpType} (${currentVersion} -> ${nextVersion})`,
  );

  for (const { packageJsonPath, packageJson } of packageJsons) {
    packageJson.version = nextVersion;
    updateInternalDependencyVersions(
      packageJson,
      workspaceNames,
      currentVersion,
      nextVersion,
    );
    writeJson(packageJsonPath, packageJson);
    console.log(`[release] Updated ${path.relative(process.cwd(), packageJsonPath)}`);
  }

  const releaseSection = buildReleaseSection(nextVersion, commits);
  updateChangelog(releaseSection);
  console.log("[release] Updated CHANGELOG.md");

  run(`git add packages/*/package.json CHANGELOG.md`);
  run(`git commit -m "chore(release): ${RELEASE_TAG_PREFIX}${nextVersion}"`);
  run(`git tag ${RELEASE_TAG_PREFIX}${nextVersion}`);

  console.log(
    `[release] Created commit and tag ${RELEASE_TAG_PREFIX}${nextVersion}.`,
  );
}

main();
