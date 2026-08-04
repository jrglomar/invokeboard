// Admin console page — v1.45/v1.46, ADR-055/056. Keyless/offline (adminClient mocked).
// Covers: user list, role toggle, bootstrap-admin lock, global + per-user config,
// and v1.46 user CRUD: create (incl. shared credentials), access changes, disable, delete.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Admin } from "./Admin";

vi.mock("../lib/adminClient", () => ({
  getAdminUsers: vi.fn(),
  putGlobalConfig: vi.fn(),
  putUserConfig: vi.fn(),
  putUserRole: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  getTemplates: vi.fn(),
  createTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  applyTemplateToUser: vi.fn(),
  applyTemplateToGlobal: vi.fn(),
  // v1.73 (ADR-084) — Teams
  listTeams: vi.fn(),
  createTeam: vi.fn(),
  updateTeam: vi.fn(),
  deleteTeam: vi.fn(),
  setUserTeam: vi.fn(),
  adoptIntoTeam: vi.fn(),
}));

import * as adminClient from "../lib/adminClient";

const api = adminClient as unknown as Record<
  | "getAdminUsers" | "putGlobalConfig" | "putUserConfig" | "putUserRole"
  | "createUser" | "updateUser" | "deleteUser"
  | "getTemplates" | "createTemplate" | "deleteTemplate" | "applyTemplateToUser" | "applyTemplateToGlobal"
  | "listTeams" | "createTeam" | "updateTeam" | "deleteTeam" | "setUserTeam" | "adoptIntoTeam",
  ReturnType<typeof vi.fn>
>;

const TEMPLATE = {
  id: "t1", name: "Team A — Dev",
  config: { JIRA_DEV_BOARD_ID: "1038", JIRA_VELOCITY_SPRINTS: 6 },
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

// v1.73 (ADR-084) — Teams: a shared storage scope, distinct from the config templates above.
const TEAM = {
  id: "team1", name: "Platform squad", config: {},
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  memberCount: 1, members: [{ id: "u2", email: "dev@team.com" }],
};

const boss = {
  id: "u1", email: "boss@team.com", role: "admin" as const, bootstrapAdmin: true,
  createdAt: "2026-01-01T00:00:00Z", connections: { jira: true, github: true, ai: false }, config: {},
  // v1.67 (ADR-078) — owns Jira + GitHub, nothing to inherit (borrows from nobody).
  effective: { jira: { status: "own" }, github: { status: "own" }, ai: { status: "none" } },
  sharedProviders: null,
  credentialSourceUserId: null, sharedFrom: null, allowWrites: false, disabled: false,
  readOnly: false, canBeSource: true,
  // v1.73 (ADR-084) — unassigned by default.
  teamId: null, teamName: null,
};
const dev = {
  id: "u2", email: "dev@team.com", role: "user" as const, bootstrapAdmin: false,
  createdAt: "2026-01-02T00:00:00Z", connections: { jira: false, github: false, ai: false },
  config: { JIRA_PO_BOARD_ID: "999" },
  effective: { jira: { status: "none" }, github: { status: "none" }, ai: { status: "none" } },
  sharedProviders: null,
  credentialSourceUserId: null, sharedFrom: null, allowWrites: false, disabled: false,
  readOnly: false, canBeSource: false,
  teamId: null, teamName: null,
};
const viewer = {
  id: "u3", email: "viewer@team.com", role: "user" as const, bootstrapAdmin: false,
  createdAt: "2026-01-03T00:00:00Z", connections: { jira: false, github: false, ai: false }, config: {},
  // v1.67 (ADR-078) — borrows boss's Jira + GitHub (share-all, sharedProviders unset); no AI to borrow.
  effective: {
    jira: { status: "inherited", via: "boss@team.com" },
    github: { status: "inherited", via: "boss@team.com" },
    ai: { status: "none" },
  },
  sharedProviders: null,
  teamId: null, teamName: null,
  credentialSourceUserId: "u1", sharedFrom: "boss@team.com", allowWrites: false, disabled: false,
  readOnly: true, canBeSource: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getAdminUsers.mockResolvedValue({ users: [boss, dev], globalConfig: { JIRA_DEV_BOARD_ID: "10002" } });
  api.putGlobalConfig.mockResolvedValue({ globalConfig: { JIRA_DEV_BOARD_ID: "10002" } });
  api.putUserRole.mockImplementation((id: string, role: "admin" | "user") =>
    Promise.resolve({ ...(id === "u1" ? boss : dev), role })
  );
  api.putUserConfig.mockImplementation((id: string, config: unknown) => Promise.resolve({ ...dev, id, config }));
  api.createUser.mockResolvedValue(viewer);
  api.updateUser.mockImplementation((id: string, patch: Record<string, unknown>) =>
    Promise.resolve({ ...dev, id, ...patch })
  );
  api.deleteUser.mockResolvedValue({ deleted: true, id: "u2" });
  api.getTemplates.mockResolvedValue({ templates: [] });
  api.createTemplate.mockResolvedValue(TEMPLATE);
  api.deleteTemplate.mockResolvedValue({ deleted: true });
  api.applyTemplateToUser.mockImplementation((id: string) => Promise.resolve({ ...dev, id, config: TEMPLATE.config }));
  api.applyTemplateToGlobal.mockResolvedValue({ globalConfig: TEMPLATE.config });
  // v1.73 (ADR-084) — Teams
  api.listTeams.mockResolvedValue({ teams: [TEAM] });
  api.createTeam.mockImplementation((name: string) =>
    Promise.resolve({ id: "team2", name, config: {}, createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", memberCount: 0, members: [] })
  );
  api.updateTeam.mockImplementation((id: string, patch: Record<string, unknown>) =>
    Promise.resolve({ ...TEAM, id, ...patch })
  );
  api.deleteTeam.mockResolvedValue({ deleted: true });
  api.setUserTeam.mockImplementation((id: string, teamId: string | null) =>
    Promise.resolve({ ...dev, id, teamId, teamName: teamId ? TEAM.name : null })
  );
  api.adoptIntoTeam.mockResolvedValue({ copied: ["leaves", "retro"], skipped: ["team", "impediments"] });
});
afterEach(() => cleanup());

/** Open a user's "Manage" panel by row index (0 = boss, 1 = dev). */
function openManage(index: number) {
  fireEvent.click(screen.getAllByRole("button", { name: /^manage$/i })[index]!);
}

describe("Admin console (v1.45)", () => {
  it("lists users with their roles", async () => {
    render(<Admin />);
    await waitFor(() => expect(screen.getByText("boss@team.com")).toBeTruthy());
    expect(screen.getByText("dev@team.com")).toBeTruthy();
  });

  it("locks the role toggle for a bootstrap (ADMIN_EMAILS) admin", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("boss@team.com"));
    const makeUser = screen.getByRole("button", { name: /make user/i });
    expect(makeUser.hasAttribute("disabled")).toBe(true);
  });

  it("promotes a regular user to admin", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    fireEvent.click(screen.getByRole("button", { name: /make admin/i }));
    await waitFor(() => expect(api.putUserRole).toHaveBeenCalledWith("u2", "admin"));
  });

  it("saves global defaults with numeric fields coerced", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("boss@team.com"));
    fireEvent.change(screen.getByLabelText("Velocity sprints"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: /save global defaults/i }));
    await waitFor(() =>
      expect(api.putGlobalConfig).toHaveBeenCalledWith({ JIRA_DEV_BOARD_ID: "10002", JIRA_VELOCITY_SPRINTS: 4 })
    );
  });

  it("edits a user's per-user board override (board ID) with one Save changes", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);
    await waitFor(() => screen.getByRole("button", { name: /save changes/i }));
    // Changing the Dev board ID is what actually switches the board; row-scoped input id disambiguates.
    fireEvent.change(document.getElementById("u-u2-JIRA_DEV_BOARD_ID") as HTMLInputElement, { target: { value: "1038" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(api.putUserConfig).toHaveBeenCalledWith("u2", { JIRA_PO_BOARD_ID: "999", JIRA_DEV_BOARD_ID: "1038" })
    );
    expect(api.updateUser).not.toHaveBeenCalled(); // access unchanged → config-only save
  });
});

describe("Admin user CRUD + shared credentials (v1.46)", () => {
  it("creates a user that shares credentials from an eligible source", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("boss@team.com"));

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "viewer@team.com" } });
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "password123" } });
    // Only boss can lend (canBeSource); dev cannot.
    fireEvent.change(screen.getByLabelText("Credentials"), { target: { value: "u1" } });
    fireEvent.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() =>
      expect(api.createUser).toHaveBeenCalledWith({
        email: "viewer@team.com",
        password: "password123",
        role: "user",
        credentialSourceUserId: "u1",
        allowWrites: false,
      })
    );
    // the new shared user appears with its provenance
    await waitFor(() => expect(screen.getByText(/shared from boss@team.com/i)).toBeTruthy());
  });

  it("only offers credential sources that own a Jira connection", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("boss@team.com"));
    const select = screen.getByLabelText("Credentials") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "u1"]); // dev (u2) has no Jira → not lendable
  });

  it("shows the read-only badge for a shared-credential user", async () => {
    api.getAdminUsers.mockResolvedValue({ users: [boss, viewer], globalConfig: {} });
    render(<Admin />);
    await waitFor(() => screen.getByText("viewer@team.com"));
    expect(screen.getByText("read-only")).toBeTruthy();
  });

  it("grants Jira writes to a shared-credential user via the combined save", async () => {
    api.getAdminUsers.mockResolvedValue({ users: [boss, viewer], globalConfig: {} });
    render(<Admin />);
    await waitFor(() => screen.getByText("viewer@team.com"));
    openManage(1);
    await waitFor(() => screen.getByRole("button", { name: /save changes/i }));
    fireEvent.click(screen.getByLabelText(/allow jira changes/i));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(api.updateUser).toHaveBeenCalledWith("u3", {
        email: "viewer@team.com", credentialSourceUserId: "u1", allowWrites: true, sharedProviders: null,
      })
    );
    expect(api.putUserConfig).not.toHaveBeenCalled(); // board overrides unchanged → access-only save
  });

  it("disables an account", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);
    await waitFor(() => screen.getByRole("button", { name: /^disable$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^disable$/i }));
    await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith("u2", { disabled: true }));
  });

  it("requires a confirmation click before deleting", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);
    await waitFor(() => screen.getByRole("button", { name: /^delete$/i }));

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(api.deleteUser).not.toHaveBeenCalled(); // first click only arms the confirm

    fireEvent.click(screen.getByRole("button", { name: /confirm delete/i }));
    await waitFor(() => expect(api.deleteUser).toHaveBeenCalledWith("u2"));
    await waitFor(() => expect(screen.queryByText("dev@team.com")).toBeNull()); // removed from the list
  });

  it("resets a user's password", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);
    await waitFor(() => screen.getByLabelText("New password"));
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "brand-new-pass" } });
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));
    await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith("u2", { password: "brand-new-pass" }));
  });
});

describe("Granular per-provider sharing + email edit (v1.67, ADR-078)", () => {
  it("shows the 3-state connection indicator: own, inherited-via, and none", async () => {
    api.getAdminUsers.mockResolvedValue({ users: [boss, viewer], globalConfig: {} });
    render(<Admin />);
    await waitFor(() => screen.getByText("viewer@team.com"));
    // viewer borrows boss's Jira + GitHub (share-all default) but has no AI to borrow — unique to
    // the viewer row (boss's own badges never say "via").
    expect(screen.getByText("Jira via boss@team.com")).toBeTruthy();
    expect(screen.getByText("GitHub via boss@team.com")).toBeTruthy();
    expect(screen.queryByText(/AI via/i)).toBeNull(); // nothing to inherit — plain "none" badge
  });

  it("creates a user with a restricted sharedProviders list when not all boxes stay checked", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("boss@team.com"));

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "partial@team.com" } });
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "password123" } });
    fireEvent.change(screen.getByLabelText("Credentials"), { target: { value: "u1" } });
    // All three default CHECKED; uncheck Jira — only GitHub + AI stay shared.
    fireEvent.click(screen.getByLabelText("Share Jira"));
    fireEvent.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() =>
      expect(api.createUser).toHaveBeenCalledWith({
        email: "partial@team.com", password: "password123", role: "user",
        credentialSourceUserId: "u1", allowWrites: false, sharedProviders: ["github", "ai"],
      })
    );
  });

  it("omits sharedProviders entirely when all three boxes stay checked (legacy share-all)", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("boss@team.com"));

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "full@team.com" } });
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "password123" } });
    fireEvent.change(screen.getByLabelText("Credentials"), { target: { value: "u1" } });
    fireEvent.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() =>
      expect(api.createUser).toHaveBeenCalledWith({
        email: "full@team.com", password: "password123", role: "user",
        credentialSourceUserId: "u1", allowWrites: false,
      })
    );
  });

  it("restricts sharedProviders for an existing user via the combined save", async () => {
    api.getAdminUsers.mockResolvedValue({ users: [boss, viewer], globalConfig: {} });
    render(<Admin />);
    await waitFor(() => screen.getByText("viewer@team.com"));
    openManage(1);
    await waitFor(() => screen.getByRole("button", { name: /save changes/i }));
    fireEvent.click(screen.getByLabelText("Share Jira")); // viewer's sharedProviders was null (share-all)
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(api.updateUser).toHaveBeenCalledWith("u3", {
        email: "viewer@team.com", credentialSourceUserId: "u1", allowWrites: false,
        sharedProviders: ["github", "ai"],
      })
    );
  });

  it("edits a user's email as part of the combined save", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);
    await waitFor(() => screen.getByRole("button", { name: /save changes/i }));
    // Two "Email" fields exist while a panel is expanded: AddUserCard's, and this row's setup form.
    const emailInputs = screen.getAllByLabelText("Email");
    fireEvent.change(emailInputs[emailInputs.length - 1], { target: { value: "dev2@team.com" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(api.updateUser).toHaveBeenCalledWith("u2", {
        email: "dev2@team.com", credentialSourceUserId: null, allowWrites: false, sharedProviders: null,
      })
    );
  });
});

describe("Admin user setup — combined save + unsaved guard (v1.52, ADR-063)", () => {
  it("saves access AND board overrides in one click when both changed", async () => {
    api.getAdminUsers.mockResolvedValue({ users: [boss, viewer], globalConfig: {} });
    render(<Admin />);
    await waitFor(() => screen.getByText("viewer@team.com"));
    openManage(1);
    await waitFor(() => screen.getByRole("button", { name: /save changes/i }));
    fireEvent.click(screen.getByLabelText(/allow jira changes/i));
    fireEvent.change(document.getElementById("u-u3-JIRA_DEV_BOARD_ID") as HTMLInputElement, { target: { value: "1038" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(api.updateUser).toHaveBeenCalledWith("u3", {
        email: "viewer@team.com", credentialSourceUserId: "u1", allowWrites: true, sharedProviders: null,
      })
    );
    await waitFor(() => expect(api.putUserConfig).toHaveBeenCalledWith("u3", { JIRA_DEV_BOARD_ID: "1038" }));
  });

  it("keeps Save changes disabled until something changes", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);
    const save = await waitFor(() => screen.getByRole("button", { name: /save changes/i }));
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(document.getElementById("u-u2-JIRA_DEV_BOARD_ID") as HTMLInputElement, { target: { value: "1038" } });
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(false);
  });

  it("warns before discarding unsaved edits when closing the panel", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);
    await waitFor(() => screen.getByRole("button", { name: /save changes/i }));
    fireEvent.change(document.getElementById("u-u2-JIRA_DEV_BOARD_ID") as HTMLInputElement, { target: { value: "1038" } });
    expect(screen.getByText("unsaved")).toBeTruthy(); // header indicator

    // Closing with unsaved edits arms a discard confirm instead of collapsing.
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(screen.getByText(/discard unsaved changes/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /keep editing/i }));
    expect(screen.queryByText(/discard unsaved changes/i)).toBeNull();

    // Discard actually collapses the panel; nothing was saved.
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull());
    expect(api.putUserConfig).not.toHaveBeenCalled();
    expect(api.updateUser).not.toHaveBeenCalled();
  });

  it("spells out that the board ID (not the project key) switches the board", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);
    await waitFor(() => screen.getByRole("button", { name: /save changes/i }));
    expect(screen.getAllByText(/the board id selects which board loads/i).length).toBeGreaterThan(0);
  });
});

describe("Admin config templates (v1.47)", () => {
  it("shows an empty state and hides the template picker when there are none", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("No templates yet."));
    expect(screen.queryByLabelText("Apply a template")).toBeNull();
  });

  it("creates a template from a name + config", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("No templates yet."));

    fireEvent.click(screen.getByRole("button", { name: /new template/i }));
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Team A — Dev" } });
    // The template form has its own id prefix, so its fields are addressable alongside the global form.
    fireEvent.change(document.getElementById("tpl-JIRA_DEV_BOARD_ID") as HTMLInputElement, { target: { value: "1038" } });
    fireEvent.click(screen.getByRole("button", { name: /create template/i }));

    await waitFor(() => expect(api.createTemplate).toHaveBeenCalledWith("Team A — Dev", { JIRA_DEV_BOARD_ID: "1038" }));
    await waitFor(() => expect(screen.getByText("Team A — Dev")).toBeTruthy());
  });

  it("lists a template with its field count and deletes it after confirmation", async () => {
    api.getTemplates.mockResolvedValue({ templates: [TEMPLATE] });
    render(<Admin />);
    await waitFor(() => screen.getByText("Team A — Dev"));
    expect(screen.getByText("2 fields")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /delete template team a/i }));
    expect(api.deleteTemplate).not.toHaveBeenCalled(); // first click arms the confirm
    fireEvent.click(screen.getByRole("button", { name: /confirm delete/i }));
    await waitFor(() => expect(api.deleteTemplate).toHaveBeenCalledWith("t1"));
  });

  it("applies a template to the global defaults (replace and merge)", async () => {
    api.getTemplates.mockResolvedValue({ templates: [TEMPLATE] });
    render(<Admin />);
    await waitFor(() => screen.getByText("Team A — Dev"));

    fireEvent.change(screen.getByLabelText("Apply a template"), { target: { value: "t1" } });
    fireEvent.click(screen.getByRole("button", { name: /replace global defaults config/i }));
    await waitFor(() => expect(api.applyTemplateToGlobal).toHaveBeenCalledWith("t1", false));

    fireEvent.click(screen.getByRole("button", { name: /merge the selected template on top of global defaults/i }));
    await waitFor(() => expect(api.applyTemplateToGlobal).toHaveBeenCalledWith("t1", true));
  });

  it("applies a template to one user's overrides, not the global defaults", async () => {
    api.getTemplates.mockResolvedValue({ templates: [TEMPLATE] });
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);

    // Two pickers coexist (this user's + global); each names the scope it changes.
    const userPicker = await waitFor(() => document.getElementById("tpl-pick-u2") as HTMLSelectElement);
    fireEvent.change(userPicker, { target: { value: "t1" } });
    fireEvent.click(screen.getByRole("button", { name: /replace dev@team\.com config/i }));

    await waitFor(() => expect(api.applyTemplateToUser).toHaveBeenCalledWith("u2", "t1", false));
    expect(api.applyTemplateToGlobal).not.toHaveBeenCalled();
  });
});

describe("Admin teams — shared storage scope (v1.73, ADR-084)", () => {
  it("renders the Teams card with a team's name, member count, and member emails", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("Platform squad"));
    expect(screen.getByText("1 member")).toBeTruthy();
    expect(screen.getByText("Members: dev@team.com")).toBeTruthy();
  });

  it("creates a team from the name field", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("Platform squad"));
    fireEvent.change(screen.getByLabelText("New team name"), { target: { value: "Growth squad" } });
    fireEvent.click(screen.getByRole("button", { name: /create team/i }));
    await waitFor(() => expect(api.createTeam).toHaveBeenCalledWith("Growth squad"));
  });

  it("surfaces a 409 NAME_TAKEN error when creating a team with a duplicate name", async () => {
    api.createTeam.mockRejectedValueOnce({ code: "NAME_TAKEN", message: "A team with that name already exists" });
    render(<Admin />);
    await waitFor(() => screen.getByText("Platform squad"));
    fireEvent.change(screen.getByLabelText("New team name"), { target: { value: "Platform squad" } });
    fireEvent.click(screen.getByRole("button", { name: /create team/i }));
    await waitFor(() => expect(screen.getByText("A team with that name already exists")).toBeTruthy());
  });

  it("assigns a user to a team via the team selector, reflecting the user's current teamId", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);
    const select = (await waitFor(() => screen.getByLabelText("Team"))) as HTMLSelectElement;
    expect(select.value).toBe(""); // dev.teamId is null -> "No team"
    fireEvent.change(select, { target: { value: "team1" } });
    await waitFor(() => expect(api.setUserTeam).toHaveBeenCalledWith("u2", "team1"));
  });

  it("ties a persistent scope-change warning to the team selector via aria-describedby", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("dev@team.com"));
    openManage(1);
    const select = (await waitFor(() => screen.getByLabelText("Team"))) as HTMLSelectElement;
    const describedBy = select.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toMatch(/changes what they SEE/i);
  });

  it("surfaces the 409 IN_USE message verbatim when deleting a team with members", async () => {
    api.deleteTeam.mockRejectedValueOnce({
      code: "IN_USE",
      message: "1 user(s) belong to this team (dev@team.com). Reassign them first.",
    });
    render(<Admin />);
    await waitFor(() => screen.getByText("Platform squad"));
    fireEvent.click(screen.getByRole("button", { name: /delete team platform squad/i }));
    expect(api.deleteTeam).not.toHaveBeenCalled(); // first click only arms the confirm
    fireEvent.click(screen.getByRole("button", { name: /confirm delete/i }));
    await waitFor(() =>
      expect(screen.getByText("1 user(s) belong to this team (dev@team.com). Reassign them first.")).toBeTruthy()
    );
  });

  it("renders a summarising notice after adopting a user's data into a team", async () => {
    render(<Admin />);
    await waitFor(() => screen.getByText("Platform squad"));
    fireEvent.change(screen.getByLabelText("Adopt data from…"), { target: { value: "u1" } });
    fireEvent.click(screen.getByRole("button", { name: /^adopt$/i }));
    await waitFor(() => expect(api.adoptIntoTeam).toHaveBeenCalledWith("team1", "u1"));
    await waitFor(() =>
      expect(screen.getByText("Copied 2 document(s); skipped 2 (already present or empty).")).toBeTruthy()
    );
  });
});
