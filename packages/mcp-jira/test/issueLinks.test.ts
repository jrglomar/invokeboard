// link_dev_to_po / unlink_dev_from_po tool tests — v1.72, ADR-083. Keyless/offline
// (jiraClient mocked). See CONTRACTS.md §4.31/§4.32 for the behavior pinned here.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockedObject,
} from "vitest";
import { resetConfigCache } from "../src/lib/config.js";

vi.mock("../src/lib/jiraClient.js", () => ({
  getLinkedIssues: vi.fn(),
  createIssueLink: vi.fn(),
  deleteIssueLink: vi.fn(),
}));

import * as jiraClient from "../src/lib/jiraClient.js";
import { linkDevToPo } from "../src/tools/linkDevToPo.js";
import { unlinkDevFromPo } from "../src/tools/unlinkDevFromPo.js";

const client = jiraClient as MockedObject<typeof jiraClient>;

// Suite pins JIRA_LINK_TYPE="Relates" (NOT the "Depends on" default) — assertions below
// use this configured value, matching the tools.test.ts / ticketActions.test.ts convention.
function setRequiredEnv() {
  process.env["JIRA_BASE_URL"] = "https://test.atlassian.net";
  process.env["JIRA_EMAIL"] = "test@example.com";
  process.env["JIRA_API_TOKEN"] = "test-token";
  process.env["JIRA_PO_BOARD_ID"] = "10001";
  process.env["JIRA_DEV_BOARD_ID"] = "10002";
  process.env["JIRA_PO_PROJECT_KEY"] = "PO";
  process.env["JIRA_DEV_PROJECT_KEY"] = "DEV";
  process.env["JIRA_LINK_TYPE"] = "Relates";
}

const originalEnv = { ...process.env };

beforeEach(() => {
  resetConfigCache();
  setRequiredEnv();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetConfigCache();
});

describe("link_dev_to_po (v1.72, ADR-083)", () => {
  it("happy path: no existing links — POSTs once with PO on inwardKey, Dev on outwardKey", async () => {
    client.getLinkedIssues.mockResolvedValueOnce([]);
    client.createIssueLink.mockResolvedValueOnce(undefined);

    const result = await linkDevToPo.handler({ poKey: "PO-1", devKey: "DEV-9" });

    expect(client.createIssueLink).toHaveBeenCalledOnce();
    expect(client.createIssueLink).toHaveBeenCalledWith({
      linkTypeName: "Relates",
      inwardKey: "PO-1",
      outwardKey: "DEV-9",
    });
    expect(result).toEqual({
      poKey: "PO-1",
      devKey: "DEV-9",
      linkTypeName: "Relates",
      created: true,
      alreadyLinked: false,
      linkId: null,
    });
  });

  it("dedupes on an existing outward link of the configured type — no POST", async () => {
    client.getLinkedIssues.mockResolvedValueOnce([
      {
        key: "DEV-9",
        summary: "Build it",
        status: "To Do",
        url: "u/DEV-9",
        linkId: "5001",
        linkTypeName: "Relates",
        direction: "outward",
      },
    ]);

    const result = await linkDevToPo.handler({ poKey: "PO-1", devKey: "DEV-9" }) as {
      created: boolean;
      alreadyLinked: boolean;
      linkId: string | null;
      reversed?: boolean;
    };

    expect(result).toEqual({
      poKey: "PO-1",
      devKey: "DEV-9",
      linkTypeName: "Relates",
      created: false,
      alreadyLinked: true,
      linkId: "5001",
    });
    expect(client.createIssueLink).not.toHaveBeenCalled();
  });

  it("flags reversed:true for a pre-v1.42 inward-side match — still no POST", async () => {
    client.getLinkedIssues.mockResolvedValueOnce([
      {
        key: "DEV-9",
        summary: "Build it",
        status: "To Do",
        url: "u/DEV-9",
        linkId: "5002",
        linkTypeName: "Relates",
        direction: "inward",
      },
    ]);

    const result = await linkDevToPo.handler({ poKey: "PO-1", devKey: "DEV-9" }) as {
      alreadyLinked: boolean;
      reversed?: boolean;
      linkId: string | null;
    };

    expect(result.alreadyLinked).toBe(true);
    expect(result.reversed).toBe(true);
    expect(result.linkId).toBe("5002");
    expect(client.createIssueLink).not.toHaveBeenCalled();
  });

  it("does NOT dedupe a link to the same devKey under a different linkTypeName — POSTs", async () => {
    client.getLinkedIssues.mockResolvedValueOnce([
      {
        key: "DEV-9",
        summary: "Build it",
        status: "To Do",
        url: "u/DEV-9",
        linkId: "5003",
        linkTypeName: "Blocks", // different type than the configured "Relates"
        direction: "outward",
      },
    ]);
    client.createIssueLink.mockResolvedValueOnce(undefined);

    const result = await linkDevToPo.handler({ poKey: "PO-1", devKey: "DEV-9" }) as {
      created: boolean;
      alreadyLinked: boolean;
    };

    expect(client.createIssueLink).toHaveBeenCalledWith({
      linkTypeName: "Relates",
      inwardKey: "PO-1",
      outwardKey: "DEV-9",
    });
    expect(result.created).toBe(true);
    expect(result.alreadyLinked).toBe(false);
  });

  it("a broken pre-check read sets precheckWarning but still creates the link", async () => {
    client.getLinkedIssues.mockRejectedValueOnce(new Error("Jira read timed out"));
    client.createIssueLink.mockResolvedValueOnce(undefined);

    const result = await linkDevToPo.handler({ poKey: "PO-1", devKey: "DEV-9" }) as {
      created: boolean;
      precheckWarning?: string;
    };

    expect(result.created).toBe(true);
    expect(result.precheckWarning).toBe("Jira read timed out");
    expect(client.createIssueLink).toHaveBeenCalledOnce();
  });

  it("rejects a self-link (poKey === devKey)", async () => {
    await expect(
      linkDevToPo.handler({ poKey: "PO-1", devKey: "PO-1" })
    ).rejects.toThrow();
    expect(client.createIssueLink).not.toHaveBeenCalled();
  });

  it("rejects a malformed key", async () => {
    await expect(
      linkDevToPo.handler({ poKey: "PO-1", devKey: "nope" })
    ).rejects.toThrow();
    expect(client.createIssueLink).not.toHaveBeenCalled();
  });

  it("propagates a createIssueLink failure rather than degrading to a warning", async () => {
    client.getLinkedIssues.mockResolvedValueOnce([]);
    client.createIssueLink.mockRejectedValueOnce(new Error("Link type not found"));

    await expect(
      linkDevToPo.handler({ poKey: "PO-1", devKey: "DEV-9" })
    ).rejects.toThrow("Link type not found");
  });
});

describe("unlink_dev_from_po (v1.72, ADR-083)", () => {
  it("guard passes: linkId belongs to the PO and matches devKey — deletes", async () => {
    client.getLinkedIssues.mockResolvedValueOnce([
      {
        key: "DEV-9",
        summary: "Build it",
        status: "To Do",
        url: "u/DEV-9",
        linkId: "5001",
        linkTypeName: "Relates",
        direction: "outward",
      },
    ]);
    client.deleteIssueLink.mockResolvedValueOnce(true);

    const result = await unlinkDevFromPo.handler({
      linkId: "5001",
      poKey: "PO-1",
      devKey: "DEV-9",
    });

    expect(client.deleteIssueLink).toHaveBeenCalledWith("5001");
    expect(result).toEqual({
      linkId: "5001",
      deleted: true,
      alreadyGone: false,
      poKey: "PO-1",
      devKey: "DEV-9",
    });
  });

  it("deleteIssueLink resolving false (Jira 404) reports alreadyGone", async () => {
    client.getLinkedIssues.mockResolvedValueOnce([
      {
        key: "DEV-9",
        summary: "Build it",
        status: "To Do",
        url: "u/DEV-9",
        linkId: "5001",
        linkTypeName: "Relates",
        direction: "outward",
      },
    ]);
    client.deleteIssueLink.mockResolvedValueOnce(false);

    const result = await unlinkDevFromPo.handler({
      linkId: "5001",
      poKey: "PO-1",
      devKey: "DEV-9",
    }) as { deleted: boolean; alreadyGone: boolean };

    expect(result.deleted).toBe(false);
    expect(result.alreadyGone).toBe(true);
  });

  it("guard: linkId absent from the PO's links — alreadyGone, no DELETE issued", async () => {
    client.getLinkedIssues.mockResolvedValueOnce([
      {
        key: "DEV-9",
        summary: "Build it",
        status: "To Do",
        url: "u/DEV-9",
        linkId: "OTHER-LINK-ID",
        linkTypeName: "Relates",
        direction: "outward",
      },
    ]);

    const result = await unlinkDevFromPo.handler({
      linkId: "5001",
      poKey: "PO-1",
      devKey: "DEV-9",
    }) as { deleted: boolean; alreadyGone: boolean };

    expect(result).toEqual({
      deleted: false,
      alreadyGone: true,
      linkId: "5001",
      poKey: "PO-1",
      devKey: "DEV-9",
    });
    expect(client.deleteIssueLink).not.toHaveBeenCalled();
  });

  it("guard: linkId present but connects a different Dev ticket — throws, no DELETE", async () => {
    client.getLinkedIssues.mockResolvedValueOnce([
      {
        key: "DEV-OTHER",
        summary: "Different ticket",
        status: "To Do",
        url: "u/DEV-OTHER",
        linkId: "5001",
        linkTypeName: "Relates",
        direction: "outward",
      },
    ]);

    await expect(
      unlinkDevFromPo.handler({ linkId: "5001", poKey: "PO-1", devKey: "DEV-9" })
    ).rejects.toThrow();
    expect(client.deleteIssueLink).not.toHaveBeenCalled();
  });

  it("no keys supplied — skips the guard entirely and deletes by linkId alone", async () => {
    client.deleteIssueLink.mockResolvedValueOnce(true);

    const result = await unlinkDevFromPo.handler({ linkId: "5001" }) as {
      deleted: boolean;
      alreadyGone: boolean;
    };

    expect(client.getLinkedIssues).not.toHaveBeenCalled();
    expect(client.deleteIssueLink).toHaveBeenCalledWith("5001");
    expect(result).toEqual({ linkId: "5001", deleted: true, alreadyGone: false });
  });
});
