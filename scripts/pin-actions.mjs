// Simple script to replace common action tags with pinned SHAs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const actions = [
  { repo: "actions/checkout", tag: "v4" },
  { repo: "actions/setup-node", tag: "v4" },
  { repo: "docker/setup-buildx-action", tag: "v3" },
  { repo: "aquasecurity/trivy-action", tag: "0.28.0" },
];

let workflow = readFileSync(".github/workflows/ci.yml", "utf8");

for (const action of actions) {
  const sha = execSync(`git ls-remote https://github.com/${action.repo} refs/tags/${action.tag}`).toString().trim().split("\t")[0];
  workflow = workflow.replaceAll(`${action.repo}@${action.tag}`, `${action.repo}@${sha}`);
}

writeFileSync(".github/workflows/ci.yml", workflow);
console.log("Pinned actions to SHAs.");