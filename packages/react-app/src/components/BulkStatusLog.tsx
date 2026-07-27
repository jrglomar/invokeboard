// BulkStatusLog — live per-row status log for a useBulkRun run, extracted from
// Linking.tsx's "creating"/"done" phase markup (v1.11, ADR-022). Generalized in v1.72
// (ADR-083) so the "Create Dev tasks", "Link existing", and "New PO from Dev tasks"
// modes all render the same log/footer, with the caller owning only the success cell
// (each mode's "ok" row looks different — a Dev-ticket link, an "already linked" badge, …).

import type { ReactNode } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { BulkRow } from "../hooks/useBulkRun";

export interface BulkStatusLogProps<TDetail> {
  rows: BulkRow<TDetail>[];
  running: boolean;
  /** Header copy: `running` while in progress, `done` as the noun after "N " (e.g. "created"). */
  title: { running: string; done: string };
  /** Caller owns the success cell's content (link, badge, warnings, …). */
  renderOk: (row: BulkRow<TDetail>) => ReactNode;
  /** Shown as "Retry failed (N)" — only rendered when errCount > 0 AND this is given. */
  onRetry?: () => void;
  /** Shown as "Start over" — only rendered when given. */
  onReset?: () => void;
}

export function BulkStatusLog<TDetail>({
  rows,
  running,
  title,
  renderOk,
  onRetry,
  onReset,
}: BulkStatusLogProps<TDetail>) {
  const okCount = rows.filter((r) => r.status === "ok").length;
  const errCount = rows.filter((r) => r.status === "error").length;

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <h3 className="text-base font-semibold flex items-center gap-2">
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
              {title.running}
            </>
          ) : (
            <>
              Done — <span className="text-success">{okCount} {title.done}</span>
              {errCount > 0 && <span className="text-destructive">, {errCount} failed</span>}
            </>
          )}
        </h3>
      </CardHeader>
      <CardContent>
        <ul role="status" aria-live="polite" className="space-y-1.5">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-2 text-sm">
              {row.status === "pending" && (
                <Loader2
                  className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0"
                  aria-hidden="true"
                />
              )}
              {row.status === "ok" && (
                <CheckCircle2 className="h-4 w-4 mt-0.5 text-success flex-shrink-0" aria-hidden="true" />
              )}
              {row.status === "error" && (
                <XCircle className="h-4 w-4 mt-0.5 text-destructive flex-shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0">
                <span className="font-mono font-semibold">{row.label}</span>{" "}
                {row.status === "pending" && <span className="text-muted-foreground">queued…</span>}
                {row.status === "ok" && renderOk(row)}
                {row.status === "error" && <span className="text-destructive">failed — {row.error}</span>}
              </span>
            </li>
          ))}
        </ul>
        {!running && (onRetry || onReset) && (
          <div className="mt-4 flex gap-2">
            {errCount > 0 && onRetry && (
              <Button type="button" onClick={onRetry}>
                Retry failed ({errCount})
              </Button>
            )}
            {onReset && (
              <Button type="button" variant="outline" onClick={onReset}>
                Start over
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
