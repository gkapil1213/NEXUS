import { validateDockerfile } from "../src/core/dockerfile-validator";
import type { DockerfileSource } from "../src/core/types";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("[PASSED] " + name + (detail ? "  Evidence: " + detail : "")); }
  else { fail++; console.log("[FAILED] " + name + (detail ? "  Evidence: " + detail : "")); }
}
function src(content: string): DockerfileSource {
  return { origin: "USE_EXISTING", content, path: "Dockerfile" };
}

(async () => {
  console.log("NEXUS DOCKERFILE VALIDATION TESTS");
  console.log("=================================\n");

  {
    const r = validateDockerfile(src("FROM alpine:3.19\nRUN adduser -D app\nUSER app\nCMD [\"echo\",\"hi\"]\n"));
    check("A1 valid Dockerfile -> PASS", r.verdict === "PASS", "verdict=" + r.verdict + " findings=" + r.findings.length);
  }
  {
    const r = validateDockerfile(src("FROM node:20-alpine\nCMD [\"node\",\"-v\"]\n"));
    const hasWarn = r.findings.some((f) => f.rule === "dockerfile.user.missing");
    check("A2 no USER -> WARN", r.verdict === "WARN" && hasWarn, "verdict=" + r.verdict);
  }
  {
    const r = validateDockerfile(src("FROM node:latest\nUSER app\nCMD [\"node\",\"-v\"]\n"));
    const hasWarn = r.findings.some((f) => f.rule === "dockerfile.latest-tag");
    check("A3 :latest tag -> WARN", r.verdict === "WARN" && hasWarn, "verdict=" + r.verdict);
  }
  {
    const r = validateDockerfile(src("FROM alpine:3.19\nRUN --privileged echo hi\nUSER app\n"));
    check("A4 --privileged -> FAIL", r.verdict === "FAIL", "verdict=" + r.verdict);
  }
  {
    const r = validateDockerfile(src("FROM alpine:3.19\nVOLUME /var/run/docker.sock\nUSER app\n"));
    check("A5 docker socket -> FAIL", r.verdict === "FAIL", "verdict=" + r.verdict);
  }
  {
    const r = validateDockerfile(src("FROM alpine:3.19\nENV API_KEY=sk-abcdefghijklmnop\nUSER app\n"));
    check("A6 embedded API key -> FAIL", r.verdict === "FAIL", "verdict=" + r.verdict);
  }
  {
    const r = validateDockerfile(src("RUN echo hi\n"));
    check("A7 missing FROM -> FAIL", r.verdict === "FAIL", "verdict=" + r.verdict);
  }
  {
    const r = validateDockerfile(src("FROM\nUSER app\n"));
    check("A8 malformed FROM -> FAIL", r.verdict === "FAIL", "verdict=" + r.verdict);
  }
  {
    const r = validateDockerfile(src("FROM alpine:3.19\nRUN rm -rf /\nUSER app\n"));
    check("A9 destructive rm -rf / -> FAIL", r.verdict === "FAIL", "verdict=" + r.verdict);
  }
  {
    const r = validateDockerfile(src("FROM alpine:3.19\nRUN curl -sSL https://example.com/i.sh | sh\nUSER app\n"));
    check("A10 curl | sh -> FAIL", r.verdict === "FAIL", "verdict=" + r.verdict);
  }
  {
    const r = validateDockerfile(src("FROM node:20-alpine AS build\nWORKDIR /app\nCOPY package.json ./\nRUN npm ci --omit=dev\nFROM node:20-alpine\nWORKDIR /app\nCOPY --from=build /app /app\nRUN addgroup -S app && adduser -S app -G app\nUSER app\nHEALTHCHECK CMD node -e \"process.exit(0)\"\nCMD [\"node\",\"-v\"]\n"));
    check("A11 clean multi-stage -> PASS", r.verdict === "PASS", "verdict=" + r.verdict + " findings=" + r.findings.length);
  }
  {
    const r = validateDockerfile(null as any);
    check("B1 null source -> BLOCKED", r.verdict === "BLOCKED", "verdict=" + r.verdict);
  }
  {
    const r = validateDockerfile(src(""));
    check("B2 empty Dockerfile -> BLOCKED", r.verdict === "BLOCKED", "verdict=" + r.verdict);
  }

  console.log("\nPASS: " + pass + "  FAIL: " + fail);
  process.exit(fail === 0 ? 0 : 1);
})();

export function run() { /* wrapper compat */ }
