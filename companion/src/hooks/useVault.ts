import { useSyncExternalStore } from "react";
import { activeServer, listServers, subscribeVault, vaultSnapshot } from "../lib/vault";
import type { PairedServer } from "../lib/vault";

/** Re-renders whenever a server is paired, forgotten, renamed or switched. */
export function useVault(): { servers: PairedServer[]; active: PairedServer | null } {
  // The store hands back the same object identity until something is written,
  // which is exactly the contract useSyncExternalStore wants.
  useSyncExternalStore(subscribeVault, vaultSnapshot, vaultSnapshot);
  return { servers: listServers(), active: activeServer() };
}
