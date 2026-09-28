// src/core/implementation-path-security.ts
// Phase 217: file-operation path hardening.
//
// FileAccessPolicy (workspace.ts) is the authoritative containment gate and
// already rejects traversal, absolute paths, and foreign-workspace refs.
// This module adds AI-output-specific rejections that are cheap and
// deterministic, applied BEFORE the operation reaches WorkspaceService:
//
//   - Windows drive letters   (C:\, D:/, etc.)
//   - UNC paths               (\\server\share)
//   - null bytes and other control characters
//   - Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
//   - trailing whitespace or dots (Windows silently strips them)
//   - empty path segments ("a//b")
//
// It does NOT replace FileAccessPolicy. It runs first, fails closed, and
// returns structured reasons that never leak the workspace filesystem.

export interface PathRejection {
  code: string;
  reason: string;
}

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const UNC_PREFIX = /^\\\\|^\/\//;
const DRIVE_LETTER = /^[a-zA-Z]:[\\/]/;

export function validateFileOperationPath(path: unknown): PathRejection | null {
  if (typeof path !== "string" || path.length === 0) {
    return { code: "PATH_EMPTY", reason: "path must be a non-empty string" };
  }
  if (path.length > 512) {
    return { code: "PATH_TOO_LONG", reason: "path exceeds 512 characters" };
  }
  if (CONTROL_CHAR.test(path)) {
    return { code: "PATH_CONTROL_CHAR", reason: "path contains a null or control character" };
  }
  if (DRIVE_LETTER.test(path)) {
    return { code: "PATH_ABSOLUTE_WINDOWS", reason: "absolute Windows paths are not permitted" };
  }
  if (UNC_PREFIX.test(path)) {
    return { code: "PATH_UNC", reason: "UNC / network paths are not permitted" };
  }
  if (path.startsWith("/")) {
    return { code: "PATH_ABSOLUTE", reason: "absolute paths are not permitted" };
  }
  if (path.includes("\\")) {
    return { code: "PATH_BACKSLASH", reason: "backslash separators are not permitted; use '/'" };
  }
  if (path.includes("//")) {
    return { code: "PATH_EMPTY_SEGMENT", reason: "empty path segments are not permitted" };
  }
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      return { code: "PATH_SEGMENT", reason: `illegal path segment: '${seg}'` };
    }
    if (WINDOWS_RESERVED.test(seg)) {
      return { code: "PATH_RESERVED_WINDOWS", reason: `reserved Windows device name: '${seg}'` };
    }
    if (/[ .]$/.test(seg)) {
      return { code: "PATH_TRAILING_DOT_SPACE", reason: "segment ends with dot or space" };
    }
  }
  return null;
}

/** Additional policy: which paths the AI is forbidden to write at all. */
const FORBIDDEN_PATHS: ReadonlyArray<RegExp> = [
  /^\.git\//,
  /^\.env($|\.)/,
  /^\.npmrc$/,
  /^\.yarnrc$/,
  /node_modules\//,
  /^\.ssh\//,
  /^\.aws\//,
  /^\.docker\/config\.json$/,
];

export function validateForbiddenPath(path: string): PathRejection | null {
  for (const re of FORBIDDEN_PATHS) {
    if (re.test(path)) {
      return { code: "PATH_FORBIDDEN", reason: `writes to '${path}' are not permitted` };
    }
  }
  return null;
}