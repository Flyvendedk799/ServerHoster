/**
 * Network isolation for CI jobs.
 *
 * Jobs get internet access (npm, pip, git) on a dedicated bridge network,
 * "survhub-ci", with inter-container traffic disabled. When ServerHoster runs
 * as root on Linux it also adds iptables rules so jobs cannot reach the host
 * itself (including the ServerHoster API) or private/link-local/CGNAT
 * addresses such as the LAN, Tailscale or cloud metadata. Without root the
 * network is still separate, but the host stays reachable via the gateway.
 */
import type Docker from "dockerode";
import { execFile } from "node:child_process";

export const CI_NETWORK = "survhub-ci";
export const CI_BRIDGE_IFACE = "survhub-ci0";

export const BLOCKED_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10"
];

export type CiNetwork = { name: string; note?: string };

let networkPromise: Promise<CiNetwork> | null = null;

/** Create the CI network once per process; fall back to the default bridge. */
export function ensureCiNetwork(docker: Docker): Promise<CiNetwork> {
  if (!networkPromise) {
    networkPromise = createNetwork(docker).then((result) => {
      if (result.name !== CI_NETWORK) networkPromise = null;
      return result;
    });
  }
  return networkPromise;
}

export function resetCiNetworkForTests(): void {
  networkPromise = null;
}

async function createNetwork(docker: Docker): Promise<CiNetwork> {
  try {
    await docker.getNetwork(CI_NETWORK).inspect();
    return { name: CI_NETWORK };
  } catch {
    /* not created yet */
  }
  try {
    await docker.createNetwork({
      Name: CI_NETWORK,
      Driver: "bridge",
      CheckDuplicate: true,
      Labels: { "survhub.ci": "1" },
      Options: {
        "com.docker.network.bridge.enable_icc": "false",
        "com.docker.network.bridge.name": CI_BRIDGE_IFACE
      }
    });
    return { name: CI_NETWORK };
  } catch (error) {
    // A concurrent create may have won the race.
    try {
      await docker.getNetwork(CI_NETWORK).inspect();
      return { name: CI_NETWORK };
    } catch {
      const text = error instanceof Error ? error.message : String(error);
      return {
        name: "bridge",
        note: `Could not create the isolated CI network (${text.slice(0, 160)}); using Docker's default bridge.`
      };
    }
  }
}

export type FirewallRule = { chain: "INPUT" | "DOCKER-USER"; spec: string[] };

/**
 * Rules in evaluation order. DNS to a private resolver stays allowed, because
 * Docker forwards a job's lookups to the host's upstream resolver, which is
 * often the LAN router.
 */
export function ciFirewallRules(iface = CI_BRIDGE_IFACE): FirewallRule[] {
  const rules: FirewallRule[] = [
    // Anything addressed to the host itself (gateway IP, public IP, API port).
    { chain: "INPUT", spec: ["-i", iface, "-j", "DROP"] },
    { chain: "DOCKER-USER", spec: ["-i", iface, "-p", "udp", "--dport", "53", "-j", "RETURN"] },
    { chain: "DOCKER-USER", spec: ["-i", iface, "-p", "tcp", "--dport", "53", "-j", "RETURN"] }
  ];
  for (const range of BLOCKED_RANGES) {
    rules.push({ chain: "DOCKER-USER", spec: ["-i", iface, "-d", range, "-j", "DROP"] });
  }
  return rules;
}

export type Runner = (cmd: string, args: string[]) => Promise<void>;

const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
  });

export type FirewallStatus = { applied: boolean; note: string };

let firewallStatus: FirewallStatus = {
  applied: false,
  note: "Not checked yet."
};

export function ciFirewallStatus(): FirewallStatus {
  return firewallStatus;
}

/**
 * Idempotently install the rules. If any rule of a chain is missing, that
 * chain's rules are removed and inserted again at the top, in order. Never
 * throws.
 */
export async function applyCiFirewall(
  opts: { platform?: NodeJS.Platform; uid?: number | null; run?: Runner } = {}
): Promise<FirewallStatus> {
  const platform = opts.platform ?? process.platform;
  const uid =
    opts.uid !== undefined ? opts.uid : typeof process.getuid === "function" ? process.getuid() : null;
  const run = opts.run ?? defaultRunner;
  if (platform !== "linux") {
    firewallStatus = {
      applied: false,
      note: "Host and LAN blocking needs Linux iptables; jobs can reach private addresses."
    };
    return firewallStatus;
  }
  if (uid !== 0) {
    firewallStatus = {
      applied: false,
      note: "ServerHoster is not running as root, so it cannot add iptables rules. Jobs run on their own network but can still reach the host and LAN."
    };
    return firewallStatus;
  }
  try {
    const rules = ciFirewallRules();
    for (const chain of ["INPUT", "DOCKER-USER"] as const) {
      const mine = rules.filter((rule) => rule.chain === chain);
      let complete = true;
      for (const rule of mine) {
        try {
          await run("iptables", ["-C", chain, ...rule.spec]);
        } catch {
          complete = false;
          break;
        }
      }
      if (complete) continue;
      // Re-add the chain's rules as a block so their order is always right.
      for (const rule of mine) {
        for (let guard = 0; guard < 5; guard += 1) {
          try {
            await run("iptables", ["-D", chain, ...rule.spec]);
          } catch {
            break;
          }
        }
      }
      for (const rule of [...mine].reverse()) {
        await run("iptables", ["-I", chain, "1", ...rule.spec]);
      }
    }
    firewallStatus = {
      applied: true,
      note: "Jobs cannot reach this host or private, link-local or CGNAT addresses."
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    firewallStatus = { applied: false, note: `Could not add iptables rules: ${text.slice(0, 200)}` };
  }
  return firewallStatus;
}
