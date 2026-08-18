/**
 * NEXUS Audit — the immutable ledger. Read-only; metadata shown exactly as
 * persisted (already secret-redacted at write time).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNexus } from "../state";
import { Badge, Button, EmptyState, Icon, Reveal, SectionHead, Skeleton, StatusPill, cx, fmtDateTime } from "../ui";
import type { AuditRecord, AuditResult } from "../core/types";

const RESULT_FILTERS: (AuditResult | "all")[] = ["all", "allow", "deny", "error", "info"];

export function AuditScreen() {
  const { services, user } = useNexus();
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  const [filter, setFilter] = useState<AuditResult | "all">("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!services) return;
    try {
      setRecords(await services.audit.list(300));
    } catch {
      setRecords([]);
    }
  }, [services]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!records) return null;
    const q = query.trim().toLowerCase();
    return records.filter(
      (r) =>
        (filter === "all" || r.result === filter) &&
        (!q || r.action.toLowerCase().includes(q) || r.actor.toLowerCase().includes(q) || r.resource_id.toLowerCase().includes(q)),
    );
  }, [records, filter, query]);

  const denied = records?.filter((r) => r.result === "deny").length ?? 0;

  return (
    <div className="space-y-6">
      <SectionHead
        kicker="immutable ledger"
        title="Audit trail"
        sub="Append-only record of authentication, authorization decisions and resource changes. Secrets are redacted before storage — what you see is exactly what was persisted."
        right={<Button variant="outline" icon="refresh" onClick={() => void load()}>Refresh</Button>}
      />

      <div className="flex flex-wrap items-center gap-2">
        {RESULT_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cx(
              "rounded-md border px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition-colors",
              filter === f ? "border-mint/50 bg-mint/10 text-mint" : "border-edge text-dim hover:text-mut",
            )}
          >
            {f}
          </button>
        ))}
        <div className="relative ml-auto w-full sm:w-64">
          <Icon name="terminal" size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter action, actor, resource…"
            className="h-9 w-full rounded-md border border-edge bg-ink-850 pl-9 pr-3 text-sm text-fg placeholder:text-dim focus:border-mint/60 focus:outline-none"
          />
        </div>
      </div>

      {denied > 0 ? (
        <p className="flex items-center gap-2 rounded-md border border-flame/25 bg-flame/[0.06] px-3 py-2 font-mono text-[11px] text-flame">
          <Icon name="shield" size={12} /> {denied} denied action(s) recorded — authorization decisions are audited, not silent
        </p>
      ) : null}

      {visible === null ? (
        <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
      ) : visible.length === 0 ? (
        <EmptyState icon="scroll" title="No audit records match" body="The ledger is append-only and empty of matches for this filter. Actions will appear as the platform is used." />
      ) : (
        <div className="panel overflow-hidden">
          {visible.map((r, i) => (
            <Reveal key={r.id} delay={Math.min(i * 20, 160)}>
              <div className="border-b border-edge/60 last:border-0">
                <button onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-ink-800/40">
                  <StatusPill status={r.result} />
                  <span className="w-44 shrink-0 truncate font-mono text-xs text-mint">{r.action}</span>
                  <span className="hidden w-40 shrink-0 truncate font-mono text-[11px] text-mut sm:block">{r.actor}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">
                    {r.resource_type} · {r.resource_id.slice(0, 24)}{r.resource_id.length > 24 ? "…" : ""}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-dim tabular-nums">{fmtDateTime(r.timestamp)}</span>
                  <Icon name="chevronDown" size={13} className={cx("shrink-0 text-dim transition-transform", open === r.id && "rotate-180")} />
                </button>
                {open === r.id ? (
                  <div className="anim-fade border-t border-edge/60 bg-ink-900/60 px-4 py-3">
                    <pre className="panel-inset overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-mut">
{JSON.stringify({ id: r.id, actor: r.actor, action: r.action, resource_type: r.resource_type, resource_id: r.resource_id, result: r.result, metadata: r.metadata, timestamp: new Date(r.timestamp).toISOString() }, null, 2)}
                    </pre>
                    <p className="mt-2 font-mono text-[10px] text-dim">
                      <Badge tone="mut" className="mr-2">redaction enforced at write time</Badge>
                      metadata shown as persisted — passwords, tokens and keys are stripped before storage
                    </p>
                  </div>
                ) : null}
              </div>
            </Reveal>
          ))}
        </div>
      )}
    </div>
  );
}
