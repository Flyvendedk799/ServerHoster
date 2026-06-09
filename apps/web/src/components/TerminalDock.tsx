import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Bot, Copy, Download, Maximize2, Minimize2, Plug, Search, Terminal, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import { connectLogs, type LiveSocket } from "../lib/ws";
import { toast } from "../lib/toast";

type DockService = {
  id: string;
  name: string;
  type?: string;
  status?: string;
};

type OpenTerminalEvent = CustomEvent<{
  service: DockService;
  mode?: "shell" | "agents";
}>;

type TerminalSession = {
  id: string;
  serviceId: string;
  title: string;
  kind: string;
  target: string;
  provider?: string | null;
  allowMutations?: boolean;
};

type Capability = {
  capability: string;
  interactive: boolean;
  agentReady: boolean;
  shell: string | null;
  missing: string[];
  remediation: string[];
  persistentAgentHome: boolean;
};

type AgentProvider = {
  id: "claude" | "gemini" | "codex";
  name: string;
  managedSecretKey: string;
  docsUrl: string;
};

type AgentProfile = {
  id: string;
  provider: "claude" | "gemini" | "codex";
  name: string;
  providerName: string;
  installStatus: string;
  authMode: "cli" | "managed";
  authStatus: string;
  isolatedHome: string;
  hasManagedSecret: boolean;
  managedSecretPreview?: string | null;
  managedSecretKey: string;
};

type Tab = {
  session: TerminalSession;
  service: DockService;
  buffer: string;
  status: "running" | "ended" | "error";
};

type TerminalPaneProps = {
  tab: Tab;
  active: boolean;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, rows: number, cols: number) => void;
  search: string;
};

function TerminalPane({ tab, active, onInput, onResize, search }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const writtenRef = useRef(0);

  useEffect(() => {
    if (!hostRef.current || termRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace",
      fontSize: 13,
      theme: {
        background: "#020617",
        foreground: "#dbeafe",
        cursor: "#67e8f9",
        selectionBackground: "#155e75"
      }
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);
    fit.fit();
    term.onData((data) => onInput(tab.session.id, data));
    term.onResize((size) => onResize(tab.session.id, size.rows, size.cols));
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = searchAddon;
    const resize = () => {
      fit.fit();
      onResize(tab.session.id, term.rows, term.cols);
    };
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      term.dispose();
      termRef.current = null;
      // On a genuine remount (session id change) replay the buffer from the
      // start; without this the re-created xterm would stay blank.
      writtenRef.current = 0;
    };
    // onInput/onResize are stabilized via useCallback in the parent, so this
    // effect only re-runs (disposing/recreating the xterm) when the session
    // actually changes — not on every output message.
  }, [onInput, onResize, tab.session.id]);

  useEffect(() => {
    if (!termRef.current) return;
    const next = tab.buffer.slice(writtenRef.current);
    if (next) {
      termRef.current.write(next);
      writtenRef.current = tab.buffer.length;
    }
  }, [tab.buffer]);

  useEffect(() => {
    if (active) {
      setTimeout(() => fitRef.current?.fit(), 20);
      termRef.current?.focus();
    }
  }, [active]);

  useEffect(() => {
    if (search.trim()) searchRef.current?.findNext(search);
  }, [search]);

  return <div ref={hostRef} className={`terminal-xterm ${active ? "active" : ""}`} />;
}

export function TerminalDock() {
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [agentService, setAgentService] = useState<DockService | null>(null);
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [allowMutations, setAllowMutations] = useState(false);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const wsRef = useRef<LiveSocket | null>(null);
  // Mirror of tabs for the WS reopen handler (which can't read state directly).
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.session.id === activeId) ?? tabs[0],
    [activeId, tabs]
  );

  useEffect(() => {
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const event = payload as {
        type?: string;
        sessionId?: string;
        data?: string;
        error?: string;
        reason?: string;
      };
      if (!event.type?.startsWith("terminal_") || !event.sessionId) return;
      if (event.type === "terminal_output" && typeof event.data === "string") {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.session.id === event.sessionId ? { ...tab, buffer: tab.buffer + event.data } : tab
          )
        );
      }
      if (event.type === "terminal_exit") {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.session.id === event.sessionId
              ? {
                  ...tab,
                  status: "ended",
                  buffer: `${tab.buffer}\r\n[session ended${event.reason ? `: ${event.reason}` : ""}]\r\n`
                }
              : tab
          )
        );
      }
      if (event.type === "terminal_error") {
        toast.error(event.error ?? "Terminal error");
        setTabs((prev) =>
          prev.map((tab) =>
            tab.session.id === event.sessionId
              ? {
                  ...tab,
                  status: "error",
                  buffer: `${tab.buffer}\r\n[terminal error] ${event.error ?? "unknown"}\r\n`
                }
              : tab
          )
        );
      }
    });
    // Re-attach every live session after a reconnect (the new socket otherwise
    // wouldn't receive their output).
    ws.onReopen(() => {
      for (const t of tabsRef.current) {
        if (t.status === "running") {
          ws.send(JSON.stringify({ type: "terminal_attach", sessionId: t.session.id }));
        }
      }
    });
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as OpenTerminalEvent).detail;
      if (!detail?.service?.id) return;
      setOpen(true);
      if (detail.mode === "agents") {
        setAgentService(detail.service);
        void loadAgents(detail.service);
      } else {
        void openShell(detail.service);
      }
    };
    window.addEventListener("survhub:open-terminal", onOpen);
    return () => window.removeEventListener("survhub:open-terminal", onOpen);
  }, []);

  async function attach(session: TerminalSession): Promise<void> {
    // LiveSocket.send queues until the socket is open, so this is safe even when
    // called before the connection has finished establishing.
    wsRef.current?.send(JSON.stringify({ type: "terminal_attach", sessionId: session.id }));
  }

  async function openShell(service: DockService): Promise<void> {
    try {
      const session = await api<TerminalSession>(`/services/${service.id}/terminal-sessions`, {
        method: "POST",
        body: JSON.stringify({})
      });
      const tab = {
        session: { ...session, title: session.title || `${service.name} shell` },
        service,
        buffer: "",
        status: "running" as const
      };
      setTabs((prev) => [...prev, tab]);
      setActiveId(session.id);
      setAgentService(null);
      await attach(session);
    } catch (error) {
      toast.error(`Console failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function loadAgents(service: DockService): Promise<void> {
    try {
      const [providerRows, profileRows, cap] = await Promise.all([
        api<AgentProvider[]>("/agents/providers", { silent: true }),
        api<AgentProfile[]>(`/services/${service.id}/agent-profiles`, { silent: true }),
        api<Capability>(`/services/${service.id}/terminal-capabilities`, { silent: true })
      ]);
      setProviders(providerRows);
      setProfiles(profileRows);
      setCapability(cap);
    } catch (error) {
      toast.error(`Agent panel failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function ensureProfile(service: DockService, provider: AgentProvider): Promise<AgentProfile> {
    const existing = profiles.find((profile) => profile.provider === provider.id);
    if (existing) return existing;
    const created = await api<AgentProfile>(`/services/${service.id}/agent-profiles`, {
      method: "POST",
      body: JSON.stringify({ provider: provider.id, name: "default", authMode: "cli" })
    });
    setProfiles((prev) => [...prev, created]);
    return created;
  }

  async function startAgentSession(
    service: DockService,
    provider: AgentProvider,
    action: "install-session" | "auth-session" | "run-session"
  ): Promise<void> {
    try {
      const profile = await ensureProfile(service, provider);
      const session = await api<TerminalSession>(
        `/services/${service.id}/agent-profiles/${profile.id}/${action}`,
        {
          method: "POST",
          body: JSON.stringify(action === "run-session" ? { allowMutations } : {})
        }
      );
      setTabs((prev) => [
        ...prev,
        {
          session,
          service,
          buffer: "",
          status: "running"
        }
      ]);
      setActiveId(session.id);
      await attach(session);
      await loadAgents(service);
    } catch (error) {
      toast.error(`Agent session failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function saveSecret(service: DockService, provider: AgentProvider): Promise<void> {
    try {
      const profile = await ensureProfile(service, provider);
      const value = secretDrafts[provider.id]?.trim();
      if (!value) return;
      await api(`/services/${service.id}/agent-profiles/${profile.id}/secrets`, {
        method: "POST",
        body: JSON.stringify({ key: provider.managedSecretKey, value })
      });
      await api(`/services/${service.id}/agent-profiles/${profile.id}`, {
        method: "PATCH",
        body: JSON.stringify({ authMode: "managed" })
      });
      setSecretDrafts((prev) => ({ ...prev, [provider.id]: "" }));
      await loadAgents(service);
      toast.success("Managed secret saved");
    } catch (error) {
      toast.error(`Secret save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Stable identities so TerminalPane's mount effect doesn't dispose/recreate the
  // xterm on every render (which blanked the terminal on each output message).
  const sendInput = useCallback((sessionId: string, data: string): void => {
    wsRef.current?.send(JSON.stringify({ type: "terminal_input", sessionId, data }));
  }, []);

  const sendResize = useCallback((sessionId: string, rows: number, cols: number): void => {
    wsRef.current?.send(JSON.stringify({ type: "terminal_resize", sessionId, rows, cols }));
  }, []);

  function closeTab(sessionId: string): void {
    wsRef.current?.send(JSON.stringify({ type: "terminal_detach", sessionId }));
    setTabs((prev) => prev.filter((tab) => tab.session.id !== sessionId));
    if (activeId === sessionId) {
      const remaining = tabs.filter((tab) => tab.session.id !== sessionId);
      setActiveId(remaining[0]?.session.id ?? null);
    }
  }

  function killTab(sessionId: string): void {
    wsRef.current?.send(JSON.stringify({ type: "terminal_kill", sessionId }));
  }

  function copyBuffer(): void {
    if (!activeTab) return;
    void navigator.clipboard.writeText(activeTab.buffer).then(() => toast.success("Terminal buffer copied"));
  }

  function exportBuffer(): void {
    if (!activeTab) return;
    const blob = new Blob([activeTab.buffer], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeTab.service.name}-${activeTab.session.kind}-${new Date().toISOString().slice(0, 19)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (!open) return null;

  return (
    <section className={`terminal-dock ${maximized ? "maximized" : ""}`} aria-label="Service console">
      <div className="terminal-dock-tabs">
        <button
          className="terminal-dock-grip"
          onClick={() => setMaximized(!maximized)}
          aria-label="Resize console"
        >
          {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        {tabs.map((tab) => (
          <button
            key={tab.session.id}
            className={`terminal-tab ${activeTab?.session.id === tab.session.id ? "active" : ""}`}
            onClick={() => setActiveId(tab.session.id)}
          >
            <span
              className={`term-tab-dot is-${tab.status}`}
              title={`Session ${tab.status}`}
            />
            <Terminal size={14} />
            <span>{tab.session.title || tab.service.name}</span>
            <small>{tab.status}</small>
          </button>
        ))}
        {agentService && (
          <button className="terminal-tab active">
            <Bot size={14} />
            <span>{agentService.name} agents</span>
          </button>
        )}
        <div className="terminal-dock-actions">
          <div className="terminal-dock-search">
            <Search size={13} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find" />
          </div>
          <button className="icon-button" onClick={copyBuffer} data-tooltip="Copy buffer">
            <Copy size={14} />
          </button>
          <button className="icon-button" onClick={exportBuffer} data-tooltip="Export buffer">
            <Download size={14} />
          </button>
          {activeTab && (
            <button
              className="icon-button danger"
              onClick={() => killTab(activeTab.session.id)}
              data-tooltip="Kill session"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button className="icon-button" onClick={() => setOpen(false)} data-tooltip="Hide console">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className={`terminal-dock-body ${agentService ? "with-agents" : "shell-only"}`}>
        <div className="terminal-stage">
          {tabs.length === 0 && !agentService && (
            <div className="terminal-empty">
              <Terminal size={28} />
              <p>Open a service console or agent session from Services.</p>
            </div>
          )}
          {tabs.map((tab) => (
            <div key={tab.session.id} hidden={activeTab?.session.id !== tab.session.id}>
              <TerminalPane
                tab={tab}
                active={activeTab?.session.id === tab.session.id}
                onInput={sendInput}
                onResize={sendResize}
                search={search}
              />
              <button className="terminal-close-tab" onClick={() => closeTab(tab.session.id)}>
                Close tab
              </button>
            </div>
          ))}
        </div>

        {agentService && (
          <aside className="agent-panel">
            <div className="agent-panel-header">
              <div>
                <h3>Agents for {agentService.name}</h3>
                <p className="muted small">
                  {capability
                    ? `${capability.capability} · shell ${capability.shell ?? "unavailable"}`
                    : "Checking service capabilities..."}
                </p>
              </div>
              <label className="toggle-inline">
                <input
                  type="checkbox"
                  checked={allowMutations}
                  onChange={(event) => setAllowMutations(event.target.checked)}
                />
                Allow service actions
              </label>
            </div>
            {capability && capability.remediation.length > 0 && (
              <div className="agent-warning">
                <Plug size={15} />
                <span>{capability.remediation.join(" ")}</span>
              </div>
            )}
            <div className="agent-provider-grid">
              {providers.map((provider) => {
                const profile = profiles.find((item) => item.provider === provider.id);
                return (
                  <article key={provider.id} className="agent-provider-card">
                    <div className="row between">
                      <div>
                        <h4>{provider.name}</h4>
                        <p className="muted small">
                          {profile ? `${profile.installStatus} · ${profile.authMode}` : "No profile yet"}
                        </p>
                      </div>
                      <Bot size={18} />
                    </div>
                    {profile && (
                      <p className="agent-home" title={profile.isolatedHome}>
                        {profile.isolatedHome}
                      </p>
                    )}
                    <div className="agent-secret-row">
                      <input
                        value={secretDrafts[provider.id] ?? ""}
                        onChange={(event) =>
                          setSecretDrafts((prev) => ({ ...prev, [provider.id]: event.target.value }))
                        }
                        placeholder={profile?.managedSecretPreview ?? provider.managedSecretKey}
                        type="password"
                      />
                      <button className="small" onClick={() => saveSecret(agentService, provider)}>
                        Save
                      </button>
                    </div>
                    <div className="agent-actions">
                      <button
                        className="small"
                        onClick={() => startAgentSession(agentService, provider, "install-session")}
                      >
                        Install
                      </button>
                      <button
                        className="small"
                        onClick={() => startAgentSession(agentService, provider, "auth-session")}
                      >
                        Auth
                      </button>
                      <button
                        className="small primary"
                        onClick={() => startAgentSession(agentService, provider, "run-session")}
                      >
                        Run
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}

export function openServiceTerminal(service: DockService, mode: "shell" | "agents" = "shell"): void {
  window.dispatchEvent(new CustomEvent("survhub:open-terminal", { detail: { service, mode } }));
}
