/**
 * The vault: which ServerHoster machines this phone is paired with.
 *
 * There is deliberately no companion-side account or cloud service. Pairing
 * writes a device token straight into this phone's storage and every request
 * goes directly to the machine that issued it — nothing about your fleet passes
 * through a third party. The trade-off is that the vault *is* the credential
 * store, so `forget()` is the only revocation this app can perform on its own
 * (the machine-side revoke lives in the dashboard).
 */

export type PairedServer = {
  /** The device id the machine assigned us. Unique per pairing. */
  id: string;
  /** Display name — starts as the machine's hostname, renamable here. */
  name: string;
  /** Base URL of the control plane, no trailing slash. */
  url: string;
  token: string;
  scope: "read" | "control";
  platform: string | null;
  pairedAt: string;
  /** Epoch ms. The machine expires device tokens after a year. */
  expiresAt: number;
};

type VaultState = {
  servers: PairedServer[];
  activeId: string | null;
};

const STORAGE_KEY = "serverhoster.companion.vault.v1";

const EMPTY: VaultState = { servers: [], activeId: null };

let state: VaultState = load();
const listeners = new Set<() => void>();

function load(): VaultState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as VaultState;
    if (!Array.isArray(parsed.servers)) return EMPTY;
    return {
      servers: parsed.servers.filter((s) => s && s.id && s.url && s.token),
      activeId: parsed.activeId ?? null
    };
  } catch {
    // A corrupt vault must not brick the app — the worst case is re-pairing.
    return EMPTY;
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private browsing / quota — the session still works in memory */
  }
  for (const listener of listeners) listener();
}

export function subscribeVault(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for `useSyncExternalStore` — same object until a write. */
export function vaultSnapshot(): VaultState {
  return state;
}

export function listServers(): PairedServer[] {
  return state.servers;
}

export function activeServer(): PairedServer | null {
  if (!state.activeId) return state.servers[0] ?? null;
  return state.servers.find((s) => s.id === state.activeId) ?? state.servers[0] ?? null;
}

export function setActiveServer(id: string): void {
  if (state.activeId === id) return;
  state = { ...state, activeId: id };
  persist();
}

export function addServer(server: PairedServer): void {
  // Re-pairing the same machine replaces the old entry rather than stacking a
  // duplicate: the operator's mental model is "this phone knows my Mac mini",
  // not "this phone has three tokens for my Mac mini".
  const withoutSameUrl = state.servers.filter((s) => s.url !== server.url && s.id !== server.id);
  state = { servers: [server, ...withoutSameUrl], activeId: server.id };
  persist();
}

export function forgetServer(id: string): void {
  const servers = state.servers.filter((s) => s.id !== id);
  const activeId = state.activeId === id ? (servers[0]?.id ?? null) : state.activeId;
  state = { servers, activeId };
  persist();
}

export function renameServer(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  state = {
    ...state,
    servers: state.servers.map((s) => (s.id === id ? { ...s, name: trimmed } : s))
  };
  persist();
}

/**
 * Drop a token the machine no longer accepts. Called when a request comes back
 * 401: the pairing was revoked from the dashboard, or the token aged out.
 */
export function invalidateServer(id: string): void {
  forgetServer(id);
}
