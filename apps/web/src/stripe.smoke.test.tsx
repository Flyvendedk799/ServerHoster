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

// Fake keys built at runtime: never real credentials.
const FAKE_SECRET = "sk_test_" + "A1b2C3d4".repeat(4);
const FAKE_ORG = "sk_org_" + "O7r6G5k4".repeat(4);

const key = (configured: boolean, preview: string | null) => ({ configured, preview, fingerprint: configured ? "0123456789ab" : null });
let testSecretConfigured = true;

const ACCOUNT_WEB = {
  id: "acct_1Web", name: "Web Co", country: "DK", default_currency: "eur", charges_enabled: true, payouts_enabled: false,
  details_submitted: true, livemode: false, currently_due: [], verified_at: new Date().toISOString()
};
const orgKey = (configured: boolean, verified: boolean) => ({
  ...key(configured, configured ? "sk_org_…O7r6" : null),
  verified,
  check: configured && verified ? { ok: true, livemode: false, account: ACCOUNT_WEB, key_fingerprint: "0123456789ab", at: new Date().toISOString() } : null
});

function statusBody() {
  return {
    default_mode: "test",
    default_webhook_events: ["invoice.paid", "invoice.payment_failed"],
    org: {
      api_version: "2026-10-28.endive",
      permissions: [
        { resource: "Account", access: "read", paths: ["/v1/account"], used_by: "Verify" },
        { resource: "Products", access: "write", paths: ["/v1/products"], used_by: "Product + price" },
        { resource: "Prices", access: "write", paths: ["/v1/prices"], used_by: "Product + price" },
        { resource: "Webhook endpoints", access: "write", paths: ["/v1/webhook_endpoints"], used_by: "Webhook" },
        { resource: "Customer portal configuration", access: "write", paths: ["/v1/billing_portal/configurations"], used_by: "Customer portal" }
      ]
    },
    modes: {
      test: {
        secret_key: key(testSecretConfigured, testSecretConfigured ? "sk_test_…Z9y8" : null),
        publishable_key: key(false, null),
        webhook_secret: key(false, null),
        org_key: orgKey(true, true),
        account: testSecretConfigured
          ? { id: "acct_fake123", name: "Fake Aim Co", country: "DK", default_currency: "eur", charges_enabled: false, payouts_enabled: false, details_submitted: false, livemode: false, currently_due: ["external_account"], verified_at: new Date().toISOString() }
          : null,
        setup: {}
      },
      live: { secret_key: key(true, "sk_live_…Q1w2"), publishable_key: key(false, null), webhook_secret: key(false, null), org_key: orgKey(false, false), account: null, setup: {} }
    }
  };
}

const APPS = {
  apps: [
    {
      service_id: "svc-coach", name: "OpenAim Coach staging", type: "docker", status: "running", connected: false, mode: null, connected_at: null, synced_at: null,
      restart_needed: false, account_id: null, credential_path: null, org_key_verified: null, webhook_secret: { configured: false, source: null }, verify: null, setup: null
    },
    {
      service_id: "svc-web", name: "Web", type: "process", status: "stopped", connected: true, mode: "test", connected_at: new Date().toISOString(), synced_at: new Date().toISOString(),
      restart_needed: true, account_id: "acct_1Web", credential_path: "org-key", org_key_verified: true, webhook_secret: { configured: true, source: "app" },
      verify: { account: ACCOUNT_WEB, path: "org-key", at: new Date().toISOString() }, setup: null
    }
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
  else if (url.pathname.startsWith("/api/stripe/org/verify/")) out = { ok: true, credential_path: "org-key", mode: "test", account: ACCOUNT_WEB, service_id: null };
  else if (url.pathname.endsWith("/account") && method === "PUT") out = { ok: true, service_id: "svc-web", account_id: body?.accountId ?? null, changed: true, restart_needed: false };
  else if (url.pathname === "/api/stripe/setup/webhook") {
    out = {
      ok: true, mode: "test", credential_path: "org-key", account: "acct_1Web", created: true, updated: false,
      endpoint: { id: "we_1", url: "https://web.example.com/hook", events: ["invoice.paid"], status: "enabled" },
      secret_stored: true, secret_source: "app", secret_unavailable: false, apps_updated: ["svc-web"], restart_needed: true
    };
  }
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

  it("explains the organization master key and what it needs, without ever showing a key", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Organization master key")).toBeTruthy());
    expect(screen.getByText(/never given to an app/)).toBeTruthy();
    expect(screen.getByText(/happens in the Stripe Dashboard/)).toBeTruthy();
    const perms = screen.getByRole("group", { name: "Permissions the organization key needs" });
    const items = within(perms).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items.length).toBe(5);
    for (const resource of ["Account", "Products", "Prices", "Webhook endpoints", "Customer portal configuration"]) {
      expect(items.some((text) => text.includes(resource)), resource).toBe(true);
    }
    expect(within(perms).getAllByText("write").length).toBe(4);
    expect(within(perms).getAllByText("read").length).toBe(1);
    expect(within(perms).getByText("2026-10-28.endive")).toBeTruthy();
    expect(screen.getByText("sk_org_…O7r6")).toBeTruthy();
    expect(screen.getByText(/verified test · acct_1Web/)).toBeTruthy();
    expect(screen.queryByText(/not verified: writes are blocked/)).toBeNull(); // test is verified, live has no key at all
    const inputs = [screen.getByLabelText("Organization key (test)"), screen.getByLabelText("Organization key (live)")] as HTMLInputElement[];
    for (const input of inputs) {
      expect(input.type).toBe("password");
      expect(input.getAttribute("autocomplete")).toBe("off");
    }
    expect(document.body.textContent).not.toMatch(/sk_org_[A-Za-z0-9]{12}/);
  });

  it("sends the organization key once to the right slot, then clears the field", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Organization master key")).toBeTruthy());
    const form = screen.getByRole("form", { name: "Organization key, test slot" });
    const input = within(form).getByLabelText("Organization key (test)") as HTMLInputElement;
    expect(within(form).getByRole("button", { name: /Save organization key/ }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: FAKE_ORG } });
    fireEvent.click(within(form).getByRole("button", { name: /Save organization key/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/stripe/keys/test")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ orgKey: FAKE_ORG });
    await waitFor(() => expect((within(form).getByLabelText("Organization key (test)") as HTMLInputElement).value).toBe(""));
    expect(document.body.textContent).not.toContain(FAKE_ORG);
  });

  it("verifies against a member account, prefilled from an app, and refuses a malformed account id", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Organization master key")).toBeTruthy());
    const form = screen.getByRole("form", { name: "Organization key, test slot" });
    const account = within(form).getByLabelText("Account to check it against") as HTMLInputElement;
    expect(account.value).toBe("acct_1Web");
    fireEvent.click(within(form).getByRole("button", { name: /Verify with Stripe/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/stripe/org/verify/test")).toBe(true));
    expect(calls.find((c) => c.path === "/api/stripe/org/verify/test")!.body).toEqual({ accountId: "acct_1Web" });

    fireEvent.change(account, { target: { value: "acct_1/acct_2" } });
    expect(within(form).getByText(/plain member account id/)).toBeTruthy();
    expect((within(form).getByRole("button", { name: /Verify with Stripe/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows each app's account, credential path and webhook-secret state, and saves or clears the account", async () => {
    mount();
    const webRow = () => within(screen.getByRole("table")).getByText("Web").closest("tr")!;
    await waitFor(() => expect(webRow()).toBeTruthy());
    const row = webRow();
    expect(within(row).getByText(/org key · acct_1Web/)).toBeTruthy();
    expect(within(row).getByText(/webhook secret: own/)).toBeTruthy();
    expect(within(row).getByText(/Web Co: charges on · payouts off/)).toBeTruthy();
    const input = within(row).getByLabelText("Stripe account for Web") as HTMLInputElement;
    expect(input.value).toBe("acct_1Web");
    const set = within(row).getByRole("button", { name: /Set/ }) as HTMLButtonElement;
    expect(set.disabled).toBe(true); // nothing changed yet

    fireEvent.change(input, { target: { value: "not-an-account" } });
    expect(set.disabled).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "acct_1New" } });
    expect(set.disabled).toBe(false);
    fireEvent.click(set);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/stripe/apps/svc-web/account")).toBe(true));
    expect(calls.find((c) => c.path === "/api/stripe/apps/svc-web/account")!.body).toEqual({ accountId: "acct_1New" });

    calls.length = 0;
    await waitFor(() => expect((within(webRow()).getByLabelText("Stripe account for Web") as HTMLInputElement).value).toBe("acct_1Web"));
    fireEvent.change(within(webRow()).getByLabelText("Stripe account for Web"), { target: { value: "" } });
    fireEvent.click(within(webRow()).getByRole("button", { name: /Set/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/account"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/account"))!.body).toEqual({ accountId: null });

    const coach = within(screen.getByRole("table")).getByText("OpenAim Coach staging").closest("tr")!;
    expect(within(coach).getByText("connect first")).toBeTruthy();
  });

  it("lets setup act in an app's account and reports which credential it used", async () => {
    mount();
    await waitFor(() => expect(screen.getByLabelText("Act in the account of")).toBeTruthy());
    const target = screen.getByLabelText("Act in the account of") as HTMLSelectElement;
    expect(screen.getByText(/Runs with the test account key/)).toBeTruthy();
    fireEvent.change(target, { target: { value: "svc-web" } });
    expect(screen.getByText(/Runs through the organization key inside acct_1Web/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Endpoint URL (https)"), { target: { value: "https://web.example.com/hook" } });
    fireEvent.click(screen.getByRole("button", { name: /Create or update webhook/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/stripe/setup/webhook")).toBe(true));
    expect(calls.find((c) => c.path === "/api/stripe/setup/webhook")!.body).toMatchObject({ mode: "test", serviceId: "svc-web", url: "https://web.example.com/hook" });
    const result = await within(screen.getByRole("form", { name: "Webhook endpoint" })).findByRole("status");
    expect(result.textContent).toMatch(/org key · acct_1Web/);
    expect(result.textContent).toMatch(/this app's own/);
    expect(document.body.textContent).not.toMatch(/whsec_/);
  });
});
