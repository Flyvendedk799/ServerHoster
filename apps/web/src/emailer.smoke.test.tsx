// @vitest-environment jsdom
import { afterEach, beforeAll, describe, it, expect } from "vitest";
import type { ComponentType } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {}
  close() {
    if (this.onclose) this.onclose();
  }
}
globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

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
Element.prototype.scrollIntoView = function scrollIntoView() {};

const now = new Date().toISOString();

const MAILBOX = {
  id: "mb1",
  address: "support@shop.dk",
  display_name: "Shop Support",
  service_id: "svc-shop",
  service_name: "shop",
  forward_url: null,
  signature: null,
  api_token_prefix: null,
  has_api_token: false,
  wildcard: false,
  unread: 1,
  threads: 1,
  created_at: now
};

const THREAD = {
  id: "t1",
  mailbox_id: "mb1",
  mailbox_address: "support@shop.dk",
  service_id: "svc-shop",
  service_name: "shop",
  local_address: "support@shop.dk",
  subject: "Where is my order?",
  counterparty: "jane@example.com",
  counterparty_name: "Jane Doe",
  status: "open",
  starred: false,
  unread_count: 1,
  message_count: 2,
  last_direction: "out",
  last_snippet: "It ships tomorrow.",
  last_message_at: now
};

const ROUTES: Record<string, unknown> = {
  "/emailer/overview": {
    smtp: { configured: true, from: "noreply@shop.dk", fromName: "Shop" },
    publicUrl: null,
    ingestUrl: "http://127.0.0.1:8787/emailer/inbound",
    apiUrl: "http://127.0.0.1:8787/emailer/api",
    cloudflare: { connected: false, worker: "localsurv-emailer" },
    summary: { unread: 1, open: 1, unassigned: 0, services: [{ service_id: "svc-shop", unread: 1, threads: 1, mailboxes: 1, last_message_at: now }] },
    stats: { received_7d: 1, sent_7d: 1, failed_7d: 0 }
  },
  "/emailer/mailboxes": [MAILBOX],
  "/services": [{ id: "svc-shop", name: "shop", status: "running", project_id: "p1" }],
  "/emailer/threads": { items: [THREAD], total: 1 },
  "/emailer/threads/t1": {
    thread: THREAD,
    messages: [
      {
        id: "m1",
        direction: "in",
        message_id: "<a@x>",
        from_addr: "jane@example.com",
        from_name: "Jane Doe",
        to: [{ address: "support@shop.dk", name: null }],
        cc: [],
        subject: "Where is my order?",
        text_body: "Hi, where is my order?\n\nOn Mon, someone wrote:\n> old stuff",
        html_body: null,
        attachments: [{ filename: "receipt.pdf", contentType: "application/pdf", size: 2048 }],
        status: "received",
        error: null,
        source: "inbound",
        forward_status: null,
        created_at: now
      },
      {
        id: "m2",
        direction: "out",
        message_id: "<b@x>",
        from_addr: "support@shop.dk",
        from_name: "Shop Support",
        to: [{ address: "jane@example.com", name: null }],
        cc: [],
        subject: "Re: Where is my order?",
        text_body: "It ships tomorrow.",
        html_body: null,
        attachments: [],
        status: "failed",
        error: "Send failed: 535 auth",
        source: "dashboard",
        forward_status: null,
        created_at: now
      }
    ]
  },
  "/emailer/services/svc-shop/stats": { received_7d: 1, sent_7d: 1, failed_7d: 0 },
  "/n8n/status": {
    installed: true,
    running: true,
    state: "running",
    reachable: true,
    ready: true,
    version: "1.80.3",
    image: "docker.n8n.io/n8nio/n8n:latest",
    startedAt: now,
    port: 5678,
    dataDir: "/data/n8n_data",
    publicUrl: null,
    openUrl: "http://127.0.0.1:5678",
    webhookUrl: "http://127.0.0.1:5678/",
    autostart: false,
    encryptionKeySet: true,
    api: { keySet: true, ok: true, error: null, settingsUrl: "http://127.0.0.1:5678/settings/api" },
    apiKeySet: true,
    config: {
      imageTag: "latest",
      timezone: "",
      pruneEnabled: true,
      pruneMaxAgeHours: 336,
      runnersEnabled: true,
      useSharedSmtp: false,
      extraEnv: {}
    },
    pendingRestart: true,
    aiGateway: { wired: false, baseUrl: null, tokenPreview: null, gatewayEnabled: false },
    updatedAt: now
  },
  "/n8n/metrics": { available: true, cpuPercent: 1.5, memoryMb: 210, memoryLimitMb: 4096 },
  "/n8n/workflows": {
    available: true,
    items: [
      {
        id: "w1",
        name: "Triage support mail",
        active: true,
        createdAt: now,
        updatedAt: now,
        tags: ["support"],
        nodeCount: 5,
        triggers: ["Webhook"],
        webhooks: [{ method: "POST", path: "triage", productionUrl: "http://127.0.0.1:5678/webhook/triage" }],
        editorUrl: "http://127.0.0.1:5678/workflow/w1"
      }
    ]
  },
  "/n8n/webhooks": {
    items: [
      {
        event: "email.received",
        label: "Email received",
        description: "Fires on inbound mail.",
        group: "Emailer",
        installed: true,
        webhookUrl: "http://127.0.0.1:5678/webhook/localsurv-email-received"
      }
    ]
  }
};

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  const body = ROUTES[url.pathname] ?? {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}) as typeof fetch;

let EmailerPage: ComponentType;
let N8nPage: ComponentType;

describe("Emailer + n8n pages", () => {
  beforeAll(async () => {
    EmailerPage = (await import("./pages/Emailer")).EmailerPage;
    N8nPage = (await import("./pages/N8n")).N8nPage;
  });

  afterEach(() => cleanup());

  it("renders a service-scoped inbox with an open conversation", async () => {
    render(
      <MemoryRouter initialEntries={["/emailer?service=svc-shop&thread=t1"]}>
        <Routes>
          <Route path="/emailer" element={<EmailerPage />} />
        </Routes>
      </MemoryRouter>
    );
    // Thread list + conversation header both show the subject.
    await waitFor(() => expect(screen.getAllByText("Where is my order?").length).toBeGreaterThan(1));
    expect(screen.getByText(/Conversations for/)).toBeTruthy();
    // Quoted history is collapsed behind a toggle, attachments listed, failed send offers retry.
    expect(screen.queryByText(/old stuff/)).toBeNull();
    expect(screen.getByText(/receipt\.pdf/)).toBeTruthy();
    expect(screen.getByText(/Not delivered/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Send reply/ })).toBeTruthy();
  });

  it("renders the n8n console with tabs, restart banner and workflows", async () => {
    render(
      <MemoryRouter initialEntries={["/n8n?tab=workflows"]}>
        <Routes>
          <Route path="/n8n" element={<N8nPage />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText("Triage support mail")).toBeTruthy());
    expect(screen.getByText(/Restart n8n to apply/)).toBeTruthy();
    const tabs = screen.getByRole("tablist", { name: "n8n sections" });
    for (const label of ["Overview", "Workflows", "Executions", "LocalSURV events", "Settings", "Logs"]) {
      expect(within(tabs).getByRole("tab", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.getByRole("switch", { name: /Deactivate Triage support mail/ })).toBeTruthy();
  });
});
