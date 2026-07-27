// LinkingModeToggle — 3-way segmented control for the Linking page's mode switch
// (v1.72, ADR-083). Same a11y pattern as the Reports mode toggle (Reports.tsx's
// ReportsModeToggle): role="group" with a label, each segment an aria-pressed button.

export type LinkingMode = "create-dev" | "link-existing" | "new-po";

export interface LinkingModeToggleProps {
  mode: LinkingMode;
  onChange: (mode: LinkingMode) => void;
}

const MODES: { key: LinkingMode; label: string }[] = [
  { key: "create-dev", label: "Create Dev tasks" },
  { key: "link-existing", label: "Link existing" },
  { key: "new-po", label: "New PO from Dev tasks" },
];

export function LinkingModeToggle({ mode, onChange }: LinkingModeToggleProps) {
  // a11y: role="group" with label; each segment has aria-pressed — same pattern as
  // Reports.tsx's ReportsModeToggle/ReportsBoardToggle.
  return (
    <div
      role="group"
      aria-label="Linking mode"
      className="flex items-center gap-1 rounded-md border border-border bg-muted p-0.5"
    >
      {MODES.map(({ key, label }) => {
        const pressed = mode === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(key)}
            className={`
              px-3 py-1 rounded-sm text-xs font-semibold transition-colors
              ${pressed
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/60"}
            `}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
