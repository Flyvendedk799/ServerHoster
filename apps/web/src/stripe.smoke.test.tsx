// @vitest-environment jsdom
import { afterEach, beforeAll, describe, it, expect } from "vitest";
import type { ComponentType } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const store = new Map<string, string>([["survhub_token", "test"]]);
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  }
} as Storage;

// Fake key built at runtime: never a real credential.
const FAKE_SECRET = "sk_test_" + "A1b2C3d4".repeat(4);

const key = (configured: boolean, preview: string | null) => ({ configured, preview, fingerprint: configured ? "0123456789ab" : null });
let testSecretConfigured = true;

function statusBody() {
  return {
    default_mode: "test",
    default_webhook_events: ["invoice.paid", "invoice.payment_failed"],
    modes: {
      test: {
        secret_key: key(testSecretConfigured, testSecretConfigured ? "sk_test_…Z9y8" : null),
        publishable_key: key(false, null),
        webhook_secret: key(false, null),
        account: testSecretConfigured
          ? { id: "acct_fake123", name: "Fake Aim Co", country: "DK", default_currency: "eur", charges_enabled: false, payouts_enabled: false, details_submitted: false, livemode: false, currently_due: ["external_account"], verified_at: new Date().toISOString() }
          : null,
        setup: {}
      },
      live: { secret_key: key(true, "sk_live_…Q1w2"), publishable_key: key(false, null), webhook_secret: key(false, null), account: null, setup: {} }
    }
  };
}

const APPS = {
  apps: [
    { service_id: "svc-coach", name: "OpenAim Coach staging", type: "docker", status: "running", connected: false, mode: null, connected_at: null, synced_at: null, restart_needed: false },
    { service_id: "svc-web", name: "Web", type: "process", status: "stopped", connected: true, mode: "test", connected_at: new Date().toISOString(), synced_at: new Date().toISOString(), restart_needed: true }
  ]
};

const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost");
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  calls.push({ method, path: url.pathname, body });
  let out: unknown = {};
  if (url.pathname === "/api/stripe/status") out = statusBody();
  else if (url.pathname === "/api/stripe/apps" && method === "GET") out = APPS;
  else if (url.pathname.startsWith("/api/stripe/keys/") && method === "PUT") {
    testSecretConfigured = true;
    out = { ok: true, apps_updated: [], restart_needed: false };
  } else if (url.pathname.endsWith("/connect")) out = { ok: true, env: ["STRIPE_SECRET_KEY"], replaced: [], restart_needed: true };
  return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) } as Response;
}) as typeof fetch;

let StripePage: ComponentType;

function mount() {
  render(
    <MemoryRouter initialEntries={["/stripe"]}>
      <Routes>
        <Route path="/stripe" element={<StripePage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Stripe page", () => {
  beforeAll(async () => {
    StripePage = (await import("./pages/Stripe")).StripePage;
  });
  afterEach(() => {
    cleanup();
    calls.length = 0;
    testSecretConfigured = true;
  });

  it("shows masked previews and account state, with labelled password inputs that never autofill", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("sk_test_…Z9y8")).toBeTruthy());
    expect(screen.getByText("sk_live_…Q1w2")).toBeTruthy();
    expect(screen.getByText(/Fake Aim Co/)).toBeTruthy();
    expect(screen.getAllByText(/Charges enabled/).length).toBeGreaterThan(0);
    expect(screen.getByText(/external_account/)).toBeTruthy();
    expect(screen.getByText(/What only you can do in Stripe/)).toBeTruthy();

    for (const label of ["Secret key", "Publishable key", "Webhook signing secret"]) {
      const inputs = screen.getAllByLabelText(label) as HTMLInputElement[];
      expect(inputs.length).toBe(2); // test and live cards
      for (const input of inputs) {
        expect(input.type).toBe("password");
        expect(input.getAttribute("autocomplete")).toBe("off");
      }
    }
    expect(screen.getAllByRole("button", { name: /Update|Connect/ }).length).toBe(2); // one per app
    expect(screen.getByText("restart needed")).toBeTruthy();
  });

  it("sends a new key once, then clears the field so it is not kept in the page", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("sk_test_…Z9y8")).toBeTruthy());
    const testCard = screen.getByRole("region", { name: /Test mode/ });
    const secret = within(testCard).getByLabelText("Secret key") as HTMLInputElement;
    fireEvent.change(secret, { target: { value: FAKE_SECRET } });
    expect(secret.value).toBe(FAKE_SECRET);
    fireEvent.click(within(testCard).getByRole("button", { name: /Save test keys/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/stripe/keys/test")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ secretKey: FAKE_SECRET });
    await waitFor(() => expect((within(testCard).getByLabelText("Secret key") as HTMLInputElement).value).toBe(""));
    expect(document.body.textContent).not.toContain(FAKE_SECRET);
  });

  it("holds a live connection until LIVE is typed, then sends confirmLive", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("OpenAim Coach staging")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Stripe mode for OpenAim Coach staging"), { target: { value: "live" } });
    const row = screen.getByText("OpenAim Coach staging").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /Connect/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Inject LIVE Stripe keys into OpenAim Coach staging/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: /Confirm live change/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/connect"))).toBe(false);

    fireEvent.change(within(dialog).getByLabelText("Type LIVE to confirm"), { target: { value: "live" } });
    expect(confirm.disabled).toBe(true); // case matters
    fireEvent.change(within(dialog).getByLabelText("Type LIVE to confirm"), { target: { value: "LIVE" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(calls.some((c) => c.path === "/api/stripe/apps/svc-coach/connect")).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/connect"))!.body).toEqual({ mode: "live", confirmLive: true, takeover: false });
  });

  it("connects in test mode without a live confirmation", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("OpenAim Coach staging")).toBeTruthy());
    const row = screen.getByText("OpenAim Coach staging").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /Connect/ }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/connect"))).toBe(true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.find((c) => c.path.endsWith("/connect"))!.body).toEqual({ mode: "test", confirmLive: false, takeover: false });
  });

  it("fills the OpenAim Coach preset into the price form", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("OpenAim Coach staging")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Fill in OpenAim Coach/ }));
    expect((screen.getByLabelText("Product name") as HTMLInputElement).value).toBe("OpenAim Coach");
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("9");
    expect((screen.getByLabelText("Lookup key") as HTMLInputElement).value).toBe("openaim_coach_monthly");
  });
});
