// @vitest-environment jsdom
/**
 * UI smoke for the Database-Tracker Phase 6 surface (Verification Matrix):
 * - recognition for a LearnAI-like service shows "Add Local Supabase", not "Add Postgres"
 * - the provision modal renders detection / secrets / bootstrap steps
 * - the resource status view (Stacks) shows URLs and degraded functions
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ComponentType } from "react";

class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {}
  send(_data: string) {}
  close() {
    if (this.onclose) this.onclose();
  }
}
globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => {
    store.clear();
  },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  }
} as Storage;

// Services.tsx pulls in TerminalDock → xterm, which probes canvas at import time.
HTMLCanvasElement.prototype.getContext =
  (() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// ---- fixtures ---------------------------------------------------------------

const signals = [
  { kind: "package", value: "@supabase/supabase-js", source_file: "package.json", confidence: "high" },
  { kind: "migration", value: "supabase/migrations", source_file: "supabase/migrations", confidence: "high" },
  {
    kind: "function",
    value: "send-email",
    source_file: "supabase/functions/send-email/index.ts",
    confidence: "medium"
  }
];

const supabasePlan = {
  profile: "supabase",
  service_id: "svc1",
  project_id: "p1",
  confidence: "high",
  signals,
  actions: [
    { id: "apply-migrations", label: "Apply schema migrations", risk: "safe", default_enabled: true },
    { id: "run-seed", label: "Run seed data", risk: "destructive", default_enabled: false },
    { id: "serve-functions", label: "Serve Edge Functions", risk: "safe", default_enabled: true }
  ],
  env: {
    generated: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    required_user_input: [],
    optional_user_input: ["LOVABLE_API_KEY"],
    injected: ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"]
  }
};

const scanRecord = {
  id: "scan1",
  service_id: "svc1",
  profile: "supabase",
  confidence: "high",
  signals,
  env_requirements: [
    {
      key: "LOVABLE_API_KEY",
      classification: "optional-external",
      source_files: ["supabase/functions/send-email/index.ts"]
    }
  ],
  created_at: "2026-06-10T00:00:00.000Z"
};

const noneProvider = {
  kind: "none",
  label: "No database provider",
  profile: null,
  source: "none"
};

const supabaseRecognition = {
  service_id: "svc1",
  service_name: "learnai",
  project_id: "p1",
  service_type: "process",
  detected: {
    profile: "supabase",
    confidence: "high",
    signals,
    env_requirements: scanRecord.env_requirements,
    scan_id: "scan1",
    scan_created_at: "2026-06-10T00:00:00.000Z",
    stale: false
  },
  providers: [noneProvider],
  current_provider: noneProvider,
  state: "missing",
  issues: [
    {
      code: "missing-provider",
      severity: "warning",
      message: "No Supabase provider is linked for this service.",
      action_id: "provision"
    }
  ],
  actions: [
    {
      id: "provision",
      label: "Provision Local Supabase",
      kind: "provision",
      profile: "supabase",
      preferred: true
    },
    { id: "rescan", label: "Rescan", kind: "rescan" }
  ],
  preference: { mode: "auto" }
};

const redisRecognition = {
  ...supabaseRecognition,
  detected: {
    ...supabaseRecognition.detected,
    profile: "redis",
    signals: [{ kind: "package", value: "redis", source_file: "package.json", confidence: "high" }],
    env_requirements: []
  },
  issues: [
    {
      code: "missing-provider",
      severity: "warning",
      message: "No Redis provider is linked for this service.",
      action_id: "provision"
    }
  ],
  actions: [
    { id: "provision", label: "Provision Redis", kind: "provision", profile: "redis", preferred: true },
    { id: "rescan", label: "Rescan", kind: "rescan" }
  ]
};

const hostedSupabaseProvider = {
  kind: "hosted-env",
  label: "Hosted Supabase URL",
  profile: "supabase",
  source: "service-env",
  env_key: "VITE_SUPABASE_URL",
  env_value_preview: "https://project.supabase.co"
};

const localSupabaseProvider = {
  kind: "managed-resource",
  label: "learnai-supabase",
  profile: "supabase",
  source: "resource",
  resource_id: "r1",
  status: "running"
};

const hostedConflictRecognition = {
  ...supabaseRecognition,
  providers: [hostedSupabaseProvider, localSupabaseProvider],
  current_provider: hostedSupabaseProvider,
  state: "conflict",
  issues: [
    {
      code: "env-override",
      severity: "error",
      message: "Service-level env overrides the linked local provider, so the service may not use the local database.",
      evidence: ["VITE_SUPABASE_URL", "learnai-supabase"],
      action_id: "fix-env"
    }
  ],
  actions: [
    { id: "use-hosted", label: "Use hosted/manual env", kind: "set-preference", preferred: true },
    { id: "fix-env", label: "Remove or update overriding service env", kind: "fix-env", preferred: true },
    { id: "rescan", label: "Rescan", kind: "rescan" }
  ]
};

const stackResource = {
  id: "r1",
  project_id: "p1",
  name: "learnai-supabase",
  profile: "supabase",
  status: "running",
  config: {
    api_url: "http://127.0.0.1:54321",
    studio_url: "http://127.0.0.1:54323",
    mode: "schema-only"
  },
  ports: {},
  containers: ["supabase_db_learnai"],
  created_at: "2026-06-10T00:00:00.000Z",
  updated_at: "2026-06-10T00:00:00.000Z",
  secrets: [
    {
      key: "SUPABASE_ANON_KEY",
      is_generated: true,
      value_preview: "ey****ab",
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-10T00:00:00.000Z"
    }
  ],
  links: [
    {
      id: "l1",
      service_id: "svc1",
      resource_id: "r1",
      active: true,
      env_map: {},
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-10T00:00:00.000Z"
    }
  ]
};

const envRequirements = {
  resource_id: "r1",
  serving: true,
  functions: [
    {
      name: "send-email",
      path: "supabase/functions/send-email",
      status: "degraded",
      missing_secrets: ["LOVABLE_API_KEY"],
      secrets: [
        {
          key: "LOVABLE_API_KEY",
          classification: "optional-external",
          source_files: ["supabase/functions/send-email/index.ts"],
          state: "missing-optional"
        }
      ]
    }
  ],
  aggregate: [
    {
      key: "LOVABLE_API_KEY",
      classification: "optional-external",
      source_files: ["supabase/functions/send-email/index.ts"],
      state: "missing-optional"
    }
  ]
};

/**
 * The /resources fixture is per-test: an empty list for the Services-page test
 * (no stack provisioned yet → the prompt must show), the running stack for the
 * Stacks-view test.
 */
let resourcesFixture: unknown[] = [];
let scansFixture: unknown[] = [scanRecord];
let recognitionsFixture: unknown[] = [supabaseRecognition];
let orphanServicesFixture: unknown[] = [];
let provisionRequests: Array<{ path: string; body: unknown }> = [];
let preferenceRequests: Array<{ path: string; body: unknown }> = [];

/** Route-keyed fetch mock; unknown GETs return []. */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  if (path === "/projects") return jsonResponse([{ id: "p1", name: "LearnAI" }]);
  if (path === "/services")
    return jsonResponse([
      { id: "svc1", name: "learnai", type: "process", status: "stopped", project_id: "p1" }
    ]);
  if (path === "/databases") return jsonResponse([]);
  if (path === "/databases/orphan-services") return jsonResponse(orphanServicesFixture);
  if (path === "/resources/scans") return jsonResponse(scansFixture);
  if (path === "/resources/scans/svc1/run")
    return jsonResponse({ scan: scanRecord, plans: [supabasePlan], recommended: supabasePlan });
  if (path === "/resources/recognition") return jsonResponse(recognitionsFixture);
  if (path === "/resources/recognition/svc1" || path === "/resources/recognition/svc1/run")
    return jsonResponse(recognitionsFixture[0] ?? supabaseRecognition);
  if (path === "/resources/recognition/svc1/preference") {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    preferenceRequests.push({ path, body });
    const updated = {
      ...(recognitionsFixture[0] ?? supabaseRecognition),
      preference: { mode: body.mode ?? "auto", note: body.note }
    };
    recognitionsFixture = [updated];
    return jsonResponse(updated);
  }
  if (path === "/resources") return jsonResponse(resourcesFixture);
  if (path === "/resources/provision") {
    provisionRequests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    return jsonResponse({
      id: "redis1",
      project_id: "p1",
      name: "learnai-redis",
      profile: "redis",
      status: "ready",
      config: {},
      ports: { redis: 63790 },
      containers: ["survhub-db-redis"],
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-10T00:00:00.000Z",
      secrets: [],
      links: []
    });
  }
  if (path === "/resources/r1/env-requirements") return jsonResponse(envRequirements);
  if (path === "/services/svc1/env") return jsonResponse([]);
  if (path === "/services/github-sync-statuses") return jsonResponse({ items: [] });
  return jsonResponse([]);
}) as typeof fetch;

let ServicesPage: ComponentType;
let ResourceProvisionModal: ComponentType<{
  serviceId: string;
  serviceName: string;
  profile?: string;
  onClose: () => void;
  onProvisioned: () => void;
}>;
let ResourceStacks: ComponentType<{ services: Array<{ id: string; name: string }> }>;

describe("Resources / Stacks smoke", () => {
  beforeAll(async () => {
    ServicesPage = (await import("./pages/Services")).ServicesPage;
    ResourceProvisionModal = (await import("./components/ResourceProvisionModal"))
      .ResourceProvisionModal as typeof ResourceProvisionModal;
    ResourceStacks = (await import("./components/ResourceStacks")).ResourceStacks;
  });

  afterEach(() => {
    cleanup();
    resourcesFixture = [];
    scansFixture = [scanRecord];
    recognitionsFixture = [supabaseRecognition];
    orphanServicesFixture = [];
    provisionRequests = [];
    preferenceRequests = [];
  });

  it("offers Add Local Supabase from recognition for a LearnAI-like service", async () => {
    resourcesFixture = [];
    render(
      <MemoryRouter>
        <ServicesPage />
      </MemoryRouter>
    );
    expect(await screen.findByText("Local Supabase needed")).toBeTruthy();
    expect((await screen.findAllByText("Add Local Supabase")).length).toBeGreaterThan(0);
    // Escape hatch is present.
    expect(screen.getByText("Use plain Postgres anyway")).toBeTruthy();
    // The misleading generic prompt is gone for this card.
    expect(screen.queryByText("Add Postgres")).toBeNull();
  });

  it("offers Add Redis for a Redis driver and provisions the redis profile", async () => {
    scansFixture = [];
    recognitionsFixture = [redisRecognition];
    render(
      <MemoryRouter>
        <ServicesPage />
      </MemoryRouter>
    );

    expect(await screen.findByText("Redis needed")).toBeTruthy();
    const buttons = await screen.findAllByText("Add Redis");
    const button = buttons[buttons.length - 1];
    expect(screen.queryByText("Add Postgres")).toBeNull();

    fireEvent.click(button);
    await waitFor(() =>
      expect(provisionRequests).toEqual([
        { path: "/resources/provision", body: { serviceId: "svc1", profile: "redis", restart: true } }
      ])
    );
  });

  it("stores hosted/manual recognition choices through the server preference endpoint", async () => {
    recognitionsFixture = [hostedConflictRecognition];
    render(
      <MemoryRouter>
        <ServicesPage />
      </MemoryRouter>
    );

    expect(await screen.findByText("Local Supabase configuration conflict")).toBeTruthy();
    fireEvent.click(screen.getByText("Use hosted/manual env"));

    await waitFor(() => {
      expect(preferenceRequests).toHaveLength(1);
      expect(preferenceRequests[0]).toMatchObject({
        path: "/resources/recognition/svc1/preference",
        body: { mode: "hosted" }
      });
    });
    expect(Array.from(store.keys()).some((key) => key.includes("hosted_supabase"))).toBe(false);
  });

  it("provision modal walks detection → secrets → bootstrap → confirm", async () => {
    render(
      <ResourceProvisionModal
        serviceId="svc1"
        serviceName="learnai"
        profile="supabase"
        onClose={() => undefined}
        onProvisioned={() => undefined}
      />
    );
    // Step 1: detection summary with signals + confidence badge.
    expect(await screen.findByText("Supabase app detected")).toBeTruthy();
    expect(screen.getByText("@supabase/supabase-js")).toBeTruthy();
    expect(screen.getByText("high confidence")).toBeTruthy();

    // Step 2: mode (schema-only default).
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("Schema only (recommended)")).toBeTruthy();

    // Step 3: secrets — generated badges and the optional external key.
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("SUPABASE_SERVICE_ROLE_KEY")).toBeTruthy();
    expect(screen.getByText("LOVABLE_API_KEY")).toBeTruthy();
    expect(screen.getByText("Disable locally")).toBeTruthy();

    // Step 4: functions with serve toggle.
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("send-email")).toBeTruthy();

    // Step 5: bootstrap (optional, skippable).
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("First local user (optional)")).toBeTruthy();

    // Step 6: confirm with the no-hosted-data promise.
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getAllByText(/No hosted data will be copied/).length).toBeGreaterThan(0);
    expect(screen.getByText("Provision local stack")).toBeTruthy();
  });

  it("stacks view shows URLs and degraded function state", async () => {
    resourcesFixture = [stackResource];
    render(<ResourceStacks services={[{ id: "svc1", name: "learnai" }]} />);
    expect(await screen.findByText("learnai-supabase")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:54321")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:54323")).toBeTruthy();
    expect(screen.getByText(/send-email · degraded/)).toBeTruthy();
    expect(screen.getByText("1 optional missing")).toBeTruthy();
    expect(screen.getByText("learnai")).toBeTruthy();
  });
});
