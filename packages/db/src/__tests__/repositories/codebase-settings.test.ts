import { describe, expect, it } from "vitest";
import "../setup.js";
import {
  getCodebaseSettings,
  listCodebaseSettings,
  setCodebaseSetupCommand,
} from "../../repositories/codebase-settings.js";
import { insertOrg } from "../fixtures.js";

describe("codebase-settings repository", () => {
  it("returns undefined for a codebase with no settings", async () => {
    const org = await insertOrg();
    await expect(getCodebaseSettings(org.id, "acme/widgets")).resolves.toBeUndefined();
  });

  it("stores, replaces, and clears a setup command", async () => {
    const org = await insertOrg();

    await setCodebaseSetupCommand(org.id, "acme/widgets", "  make deps  ");
    await expect(getCodebaseSettings(org.id, "acme/widgets")).resolves.toMatchObject({ setupCommand: "make deps" });

    await setCodebaseSetupCommand(org.id, "acme/widgets", "./bootstrap.sh");
    await expect(getCodebaseSettings(org.id, "acme/widgets")).resolves.toMatchObject({ setupCommand: "./bootstrap.sh" });

    await setCodebaseSetupCommand(org.id, "acme/widgets", "   ");
    await expect(getCodebaseSettings(org.id, "acme/widgets")).resolves.toMatchObject({ setupCommand: null });
    await expect(listCodebaseSettings(org.id)).resolves.toHaveLength(1);
  });

  it("scopes settings to the org", async () => {
    const orgA = await insertOrg();
    const orgB = await insertOrg();
    await setCodebaseSetupCommand(orgA.id, "acme/widgets", "make deps");

    await expect(getCodebaseSettings(orgB.id, "acme/widgets")).resolves.toBeUndefined();
    await expect(listCodebaseSettings(orgB.id)).resolves.toEqual([]);
  });

  it("rejects a command over the length cap", async () => {
    const org = await insertOrg();
    await expect(setCodebaseSetupCommand(org.id, "acme/widgets", "x".repeat(4097))).rejects.toThrow(/4096/);
  });
});
