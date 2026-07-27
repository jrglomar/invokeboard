// SprintSelect tests — shared native <select> + <optgroup> sprint picker, extracted
// from Linking.tsx (v1.11, ADR-022) for reuse across the Linking modes (v1.72, ADR-083).
// Pure presentational/controlled component — no module mocks needed.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SprintSelect } from "./SprintSelect";
import type { ListSprintsResponse, SprintRef } from "../lib/types";

afterEach(() => cleanup());

const mkSprint = (id: number, name: string, state: SprintRef["state"]): SprintRef => ({
  id,
  name,
  state,
  startDate: null,
  endDate: null,
  completeDate: null,
  goal: null,
  boardId: 10,
});

const DATA: ListSprintsResponse = {
  boardId: 10,
  active: [mkSprint(1, "Sprint A", "active")],
  future: [mkSprint(2, "Sprint B", "future")],
  closed: [mkSprint(3, "Sprint C", "closed")],
};

describe("SprintSelect — groups", () => {
  it("renders only the optgroups named in groups (hides closed sprints)", () => {
    render(
      <SprintSelect
        id="dev-sprint"
        label="Dev sprint"
        ariaLabel="Dev board sprint"
        value={undefined}
        onChange={() => {}}
        data={DATA}
        groups={["active", "future"]}
        placeholder="Select a sprint…"
      />
    );

    const select = screen.getByRole("combobox", { name: "Dev board sprint" }) as HTMLSelectElement;
    const optionTexts = Array.from(select.options).map((o) => o.text);

    expect(optionTexts).toContain("Sprint A");
    expect(optionTexts).toContain("Sprint B");
    expect(optionTexts).not.toContain("Sprint C");
  });
});

describe("SprintSelect — loading", () => {
  it("renders a skeleton instead of the select while loading", () => {
    render(
      <SprintSelect
        id="dev-sprint"
        label="Dev sprint"
        ariaLabel="Dev board sprint"
        value={undefined}
        onChange={() => {}}
        data={DATA}
        placeholder="Select a sprint…"
        loading
      />
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    // The visible <Label> still renders while the select is swapped for a skeleton.
    expect(screen.getByText("Dev sprint")).toBeTruthy();
  });
});

describe("SprintSelect — onChange", () => {
  it("selecting an option calls onChange with a number; the placeholder calls onChange with undefined", () => {
    const onChange = vi.fn();
    render(
      <SprintSelect
        id="dev-sprint"
        label="Dev sprint"
        ariaLabel="Dev board sprint"
        value={undefined}
        onChange={onChange}
        data={DATA}
        groups={["active", "future"]}
        placeholder="Select a sprint…"
      />
    );

    const select = screen.getByRole("combobox", { name: "Dev board sprint" });

    fireEvent.change(select, { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith(2);

    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
