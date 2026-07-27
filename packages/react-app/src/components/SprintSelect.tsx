// SprintSelect — shared native <select> + <optgroup> sprint picker, extracted from
// Linking.tsx (v1.11, ADR-022) so the 3 Linking modes (v1.72, ADR-083) — and any future
// page — can share one implementation instead of copy-pasting the markup per mode.

import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { ListSprintsResponse } from "../lib/types";

/**
 * Shared select styling — byte-identical to the old Linking.tsx `selectCls` constant.
 * Exported because other components (e.g. the DevTicketPicker's assignee filter) reuse it.
 */
export const selectCls =
  "h-9 w-full max-w-xs text-xs px-2 border border-border rounded-md bg-background text-foreground font-[inherit] cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 transition-colors hover:border-ring disabled:opacity-50 disabled:cursor-not-allowed";

const GROUP_LABEL: Record<"active" | "future" | "closed", string> = {
  active: "Active",
  future: "Future",
  closed: "Closed",
};

export interface SprintSelectProps {
  id: string;
  /** Visible <Label> text. */
  label: string;
  /** STABLE accessible name — must stay identical across modes for a11y-query stability. */
  ariaLabel: string;
  value: number | undefined;
  onChange: (id: number | undefined) => void;
  data: ListSprintsResponse | null;
  /** Which sprint-state groups to render, in order. Default: active + future. */
  groups?: readonly ("active" | "future" | "closed")[];
  /** The value="" option's text (e.g. "Select a PO sprint…" or "Backlog / no sprint"). */
  placeholder: string;
  /** True while the underlying data isn't ready yet — renders a Skeleton instead of the select. */
  loading?: boolean;
  /** Caller-supplied disable (e.g. a per-fetch loading flag). Combined with "no options" below. */
  disabled?: boolean;
}

export function SprintSelect({
  id,
  label,
  ariaLabel,
  value,
  onChange,
  data,
  groups = ["active", "future"],
  placeholder,
  loading,
  disabled,
}: SprintSelectProps) {
  if (loading) {
    return (
      <div className="space-y-1">
        <Label htmlFor={id} className="text-xs font-semibold">
          {label}
        </Label>
        <Skeleton className="h-9 w-48" />
      </div>
    );
  }

  // Same "nothing to pick" guard as the original page: no options in ANY visible
  // group disables the select regardless of the caller's `disabled` flag.
  const hasOptions = groups.some((g) => (data?.[g].length ?? 0) > 0);

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-semibold">
        {label}
      </Label>
      <select
        id={id}
        className={selectCls}
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : parseInt(v, 10));
        }}
        disabled={disabled || !hasOptions}
        aria-label={ariaLabel}
      >
        <option value="">{placeholder}</option>
        {groups.map((g) =>
          data && data[g].length > 0 ? (
            <optgroup key={g} label={GROUP_LABEL[g]}>
              {data[g].map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          ) : null
        )}
      </select>
    </div>
  );
}
