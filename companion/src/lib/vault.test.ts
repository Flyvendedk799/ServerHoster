import { beforeEach, describe, expect, it, vi } from "vitest";

function makeServer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "dev-1",
    name: "mac-mini",
    url: "https://box.example.com",
    token: "tok-1",
    scope: "control" as const,
    platform: "darwin",
    pairedAt: "2026-01-01T00:00:00Z",
    expiresAt: Date.now() + 1000,
    ...overrides
  };
}

/**
 * The vault reads storage once at import time, so each test gets a fresh module
 * registry rather than trying to reset a live singleton.
 */
async function freshVault() {
  vi.resetModules();
  return import("./vault");
}

describe("vault", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores a paired server and makes it active", async () => {
    const vault = await freshVault();
    vault.addServer(makeServer());
    expect(vault.listServers()).toHaveLength(1);
    expect(vault.activeServer()?.id).toBe("dev-1");
  });

  it("survives a process restart", async () => {
    const first = await freshVault();
    first.addServer(makeServer());
    const second = await freshVault();
    expect(second.activeServer()?.token).toBe("tok-1");
  });

  it("replaces rather than duplicates when the same machine is re-paired", async () => {
    const vault = await freshVault();
    vault.addServer(makeServer());
    vault.addServer(makeServer({ id: "dev-2", token: "tok-2" }));
    expect(vault.listServers()).toHaveLength(1);
    expect(vault.activeServer()?.token).toBe("tok-2");
  });

  it("keeps separate machines apart and can switch between them", async () => {
    const vault = await freshVault();
    vault.addServer(makeServer());
    vault.addServer(makeServer({ id: "dev-2", url: "https://other.example.com", token: "tok-2" }));
    expect(vault.listServers()).toHaveLength(2);
    vault.setActiveServer("dev-1");
    expect(vault.activeServer()?.id).toBe("dev-1");
  });

  it("falls back to another server when the active one is forgotten", async () => {
    const vault = await freshVault();
    vault.addServer(makeServer());
    vault.addServer(makeServer({ id: "dev-2", url: "https://other.example.com" }));
    vault.setActiveServer("dev-2");
    vault.forgetServer("dev-2");
    expect(vault.activeServer()?.id).toBe("dev-1");
    vault.forgetServer("dev-1");
    expect(vault.activeServer()).toBeNull();
  });

  it("notifies subscribers on every write", async () => {
    const vault = await freshVault();
    const seen = vi.fn();
    const unsubscribe = vault.subscribeVault(seen);
    vault.addServer(makeServer());
    vault.renameServer("dev-1", "Home box");
    expect(seen).toHaveBeenCalledTimes(2);
    expect(vault.activeServer()?.name).toBe("Home box");
    unsubscribe();
    vault.forgetServer("dev-1");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("starts empty rather than throwing when storage is corrupt", async () => {
    localStorage.setItem("serverhoster.companion.vault.v1", "{{{");
    const vault = await freshVault();
    expect(vault.listServers()).toEqual([]);
  });
});
