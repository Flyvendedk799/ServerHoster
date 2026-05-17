// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setAuthToken } from "./api";

const store = new Map<string, string>();

describe("api auth handling", () => {
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        }
      }
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("clears stale auth and emits an expiration event on 401", async () => {
    setAuthToken("stale-token");
    const listener = vi.fn();
    window.addEventListener("survhub:auth-expired", listener);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: "Unauthorized" })
    } as Response);

    await expect(api("/services/deploy-from-github", { method: "POST", silent: true })).rejects.toThrow(
      "Unauthorized"
    );

    expect(localStorage.getItem("survhub_token")).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("survhub:auth-expired", listener);
  });
});
