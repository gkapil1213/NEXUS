// src/server/logging.ts
// Phase 180: structured, secret-safe operational logging.
//
// Emits one JSON object per line to stdout. Reuses the existing
// redactText() helper from core/audit.ts so secrets never reach logs.
// Opt-in: createHttpApp only emits access lines when accessLog=true.

import { redactText } from "../core/audit";

export interface AccessLogFields {
  rid: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  principal?: string | null;
  code?: string | null;
  ts?: number;
}

const MAX_RID = 128;
const MAX_PATH = 256;
const MAX_PRINCIPAL = 128;
const MAX_CODE = 64;
const MAX_METHOD = 16;

function clip(s: unknown, n: number): string {
  const v = String(s ?? "");
  const safe = redactText(v);
  return safe.length > n ? safe.slice(0, n) : safe;
}

export function emitAccessLog(fields: AccessLogFields): void {
  const line = JSON.stringify({
    ts: fields.ts ?? Date.now(),
    kind: "http.access",
    rid: clip(fields.rid, MAX_RID),
    method: clip(fields.method, MAX_METHOD),
    path: clip(fields.path, MAX_PATH),
    status: Number.isFinite(fields.status) ? Math.trunc(fields.status) : 0,
    ms: Math.max(0, Math.trunc(Number(fields.ms) || 0)),
    principal: fields.principal ? clip(fields.principal, MAX_PRINCIPAL) : null,
    code: fields.code ? clip(fields.code, MAX_CODE) : null,
  });
  try { process.stdout.write(line + "\n"); } catch { /* best-effort */ }
}

export function emitServerEvent(kind: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: Date.now(),
    kind: "http.server." + clip(kind, 64),
    ...Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [
        k,
        typeof v === "string" ? redactText(v).slice(0, 256) : v,
      ]),
    ),
  });
  try { process.stdout.write(line + "\n"); } catch { /* best-effort */ }
}