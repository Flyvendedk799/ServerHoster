import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Archive,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  AtSign,
  CheckCircle2,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Inbox,
  KeyRound,
  Loader2,
  Mail,
  MailOpen,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Send,
  Server,
  Settings2,
  ShieldAlert,
  Star,
  Terminal,
  Trash2,
  Undo2,
  X,
  Zap
} from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { connectLogs } from "../lib/ws";
import { confirmDialog } from "../lib/confirm";
import { useModalA11y } from "../lib/useModalA11y";
import { copyText, shortStamp, timeAgo } from "../lib/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MailAddress = { address: string; name: string | null };

type Mailbox = {
  id: string;
  address: string;
  display_name: string | null;
  service_id: string | null;
  service_name: string | null;
  forward_url: string | null;
  signature: string | null;
  api_token_prefix: string | null;
  has_api_token: boolean;
  wildcard: boolean;
  unread: number;
  threads: number;
  created_at: string;
};

type Thread = {
  id: string;
  mailbox_id: string | null;
  mailbox_address: string | null;
  service_id: string | null;
  service_name: string | null;
  local_address: string;
  subject: string;
  counterparty: string;
  counterparty_name: string | null;
  status: "open" | "archived" | "spam";
  starred: boolean;
  unread_count: number;
  message_count: number;
  last_direction: "in" | "out" | null;
  last_snippet: string | null;
  last_message_at: string;
};

type Message = {
  id: string;
  direction: "in" | "out";
  message_id: string | null;
  from_addr: string;
  from_name: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  text_body: string | null;
  html_body: string | null;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  status: string;
  error: string | null;
  source: string;
  forward_status: string | null;
  created_at: string;
};

type Summary = {
  unread: number;
  open: number;
  unassigned: number;
  services: Array<{ service_id: string; unread: number; threads: number; mailboxes: number; last_message_at: string | null }>;
};

type Overview = {
  smtp: { configured: boolean; from: string | null; fromName: string | null };
  publicUrl: string | null;
  ingestUrl: string;
  apiUrl: string;
  cloudflare: { connected: boolean; worker: string };
  summary: Summary;
  stats: { received_7d: number; sent_7d: number; failed_7d: number };
};

type ServiceLite = { id: string; name: string; status: string; project_id: string };

type Folder = "inbox" | "unread" | "starred" | "sent" | "archived" | "spam" | "all";
type View = "inbox" | "mailboxes" | "setup";

const FOLDERS: Array<{ id: Folder; label: string; icon: typeof Inbox }> = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "unread", label: "Unread", icon: Mail },
  { id: "starred", label: "Starred", icon: Star },
  { id: "sent", label: "Sent", icon: Send },
  { id: "archived", label: "Archived", icon: Archive },
  { id: "spam", label: "Spam", icon: ShieldAlert },
  { id: "all", label: "All mail", icon: MailOpen }
];

function initials(name: string | null, address: string): string {
  const src = (name || address.split("@")[0]).replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] ?? "?").slice(0, 2).toUpperCase();
}

function hueOf(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) % 360;
  return h;
}

function Avatar({ name, address, size = 34 }: { name: string | null; address: string; size?: number }) {
  return (
    <span
      className="em-avatar"
      style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hueOf(address)} 55% 42%)` }}
      aria-hidden
    >
      {initials(name, address)}
    </span>
  );
}

/** Split a plain-text body into what was written and the quoted history below it. */
function splitQuoted(text: string): { body: string; quoted: string | null } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isMarker =
      /^On .+wrote:$/i.test(line) ||
      /^Den .+skrev.*:$/i.test(line) ||
      /^-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
      /^From: .+/.test(line) && i > 0 && lines[i - 1].trim() === "";
    const quoteBlock = line.startsWith(">") && lines.slice(i).every((l) => !l.trim() || l.trim().startsWith(">"));
    if (isMarker || quoteBlock) {
      const body = lines.slice(0, i).join("\n").trimEnd();
      if (!body) break;
      return { body, quoted: lines.slice(i).join("\n") };
    }
  }
  return { body: text.trimEnd(), quoted: null };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function EmailerPage() {
  const [params, setParams] = useSearchParams();
  const view = (["inbox", "mailboxes", "setup"].includes(params.get("view") ?? "") ? params.get("view") : "inbox") as View;
  const serviceScope = params.get("service");
  const folder = (FOLDERS.some((f) => f.id === params.get("folder")) ? params.get("folder") : "inbox") as Folder;
  const mailboxFilter = params.get("mailbox");
  const unassigned = params.get("unassigned") === "1";
  const selectedId = params.get("thread");

  const patchParams = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  const [overview, setOverview] = useState<Overview | null>(null);
  const [services, setServices] = useState<ServiceLite[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [total, setTotal] = useState(0);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api<Overview>("/emailer/overview", { silent: true }));
    } catch {
      /* silent */
    }
  }, []);

  const loadMailboxes = useCallback(async () => {
    try {
      setMailboxes(await api<Mailbox[]>("/emailer/mailboxes", { silent: true }));
    } catch {
      /* silent */
    }
  }, []);

  const loadThreads = useCallback(async () => {
    const qs = new URLSearchParams({ folder, limit: "100" });
    if (serviceScope) qs.set("serviceId", serviceScope);
    if (mailboxFilter) qs.set("mailboxId", mailboxFilter);
    if (unassigned) qs.set("unassigned", "1");
    if (debouncedQ.trim()) qs.set("q", debouncedQ.trim());
    try {
      const res = await api<{ items: Thread[]; total: number }>(`/emailer/threads?${qs}`, { silent: true });
      setThreads(res.items);
      setTotal(res.total);
    } catch {
      /* silent */
    } finally {
      setThreadsLoading(false);
    }
  }, [folder, serviceScope, mailboxFilter, unassigned, debouncedQ]);

  useEffect(() => {
    void loadOverview();
    void loadMailboxes();
    api<ServiceLite[]>("/services", { silent: true })
      .then(setServices)
      .catch(() => undefined);
  }, [loadOverview, loadMailboxes]);

  useEffect(() => {
    setThreadsLoading(true);
    void loadThreads();
  }, [loadThreads]);

  // Live updates: new mail and state changes broadcast over the shared socket.
  const reloadRef = useRef<() => void>(() => undefined);
  reloadRef.current = () => {
    void loadThreads();
    void loadOverview();
    void loadMailboxes();
    setRefreshTick((n) => n + 1);
  };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ws = connectLogs((payload) => {
      const type = (payload as { type?: string } | null)?.type;
      if (type !== "emailer_message" && type !== "emailer_update") return;
      const p = payload as { direction?: string; from?: string; subject?: string };
      if (type === "emailer_message" && p.direction === "in" && p.from) {
        toast.info(`New mail from ${p.from}${p.subject ? ` — ${p.subject}` : ""}`);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => reloadRef.current(), 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      ws.close();
    };
  }, []);

  const scopedService = serviceScope ? services.find((s) => s.id === serviceScope) ?? null : null;
  const scopedMailboxes = serviceScope ? mailboxes.filter((m) => m.service_id === serviceScope) : mailboxes;
  const unreadByService = useMemo(
    () => new Map((overview?.summary.services ?? []).map((s) => [s.service_id, s])),
    [overview]
  );

  const setView = (v: View) => patchParams({ view: v === "inbox" ? null : v });

  return (
    <div className="emailer-page">
      <header className="page-header">
        <div className="title-group">
          <h2>Emailer</h2>
          <p className="muted">
            {scopedService ? (
              <>
                Conversations for <b>{scopedService.name}</b> —{" "}
                <button className="em-linkbtn" onClick={() => patchParams({ service: null, mailbox: null, thread: null })}>
                  show all services
                </button>
              </>
            ) : (
              "Two-way email conversations for your services — inbound and outbound in one place."
            )}
          </p>
        </div>
        <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
          <select
            className="em-scope"
            value={serviceScope ?? ""}
            onChange={(e) => patchParams({ service: e.target.value || null, mailbox: null, thread: null, unassigned: null })}
            aria-label="Service scope"
          >
            <option value="">All services</option>
            {services.map((s) => {
              const u = unreadByService.get(s.id)?.unread ?? 0;
              return (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {u ? ` (${u})` : ""}
                </option>
              );
            })}
          </select>
          <button className="primary small" onClick={() => setComposeOpen(true)}>
            <Pencil size={14} /> Compose
          </button>
        </div>
      </header>

      {overview && !overview.smtp.configured && view !== "setup" && (
        <div className="em-banner warn">
          <AlertTriangle size={15} />
          <span>Outbound mail needs the shared SMTP credentials.</span>
          <Link className="button small" to="/email">
            Configure SMTP
          </Link>
        </div>
      )}

      {scopedService && view === "inbox" && (
        <ServiceStrip
          service={scopedService}
          mailboxes={scopedMailboxes}
          activeMailbox={mailboxFilter}
          onMailbox={(id) => patchParams({ mailbox: id, thread: null })}
          onManage={() => setView("mailboxes")}
        />
      )}

      <nav className="em-tabs" role="tablist">
        {(
          [
            ["inbox", "Conversations", Inbox],
            ["mailboxes", "Mailboxes", AtSign],
            ["setup", "Setup", Settings2]
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            className={`em-tab ${view === id ? "active" : ""}`}
            onClick={() => setView(id)}
          >
            <Icon size={14} /> {label}
            {id === "inbox" && (overview?.summary.unread ?? 0) > 0 && (
              <span className="em-count">{overview?.summary.unread}</span>
            )}
            {id === "mailboxes" && <span className="em-count muted-count">{scopedMailboxes.length}</span>}
          </button>
        ))}
      </nav>

      {view === "inbox" && (
        <div className={`em-shell ${selectedId ? "has-selection" : ""}`}>
          <aside className="em-rail">
            {FOLDERS.map((f) => {
              const Icon = f.icon;
              const active = folder === f.id && !mailboxFilter && !unassigned;
              return (
                <button
                  key={f.id}
                  className={`em-rail-item ${active ? "active" : ""}`}
                  onClick={() => patchParams({ folder: f.id === "inbox" ? null : f.id, mailbox: null, unassigned: null, thread: null })}
                >
                  <Icon size={14} />
                  <span>{f.label}</span>
                  {f.id === "inbox" && !serviceScope && (overview?.summary.unread ?? 0) > 0 && (
                    <span className="em-count">{overview?.summary.unread}</span>
                  )}
                  {f.id === "inbox" && serviceScope && (unreadByService.get(serviceScope)?.unread ?? 0) > 0 && (
                    <span className="em-count">{unreadByService.get(serviceScope)?.unread}</span>
                  )}
                </button>
              );
            })}
            <div className="em-rail-heading">Mailboxes</div>
            {scopedMailboxes.length === 0 && (
              <button className="em-rail-item muted" onClick={() => setView("mailboxes")}>
                <Plus size={14} /> <span>Add a mailbox</span>
              </button>
            )}
            {scopedMailboxes.map((m) => (
              <button
                key={m.id}
                className={`em-rail-item ${mailboxFilter === m.id ? "active" : ""}`}
                onClick={() => patchParams({ mailbox: m.id, unassigned: null, thread: null, folder: "all" })}
                title={m.service_name ? `${m.address} → ${m.service_name}` : m.address}
              >
                <AtSign size={14} />
                <span className="em-ellipsis">{m.address}</span>
                {m.unread > 0 && <span className="em-count">{m.unread}</span>}
              </button>
            ))}
            {!serviceScope && (overview?.summary.unassigned ?? 0) > 0 && (
              <button
                className={`em-rail-item ${unassigned ? "active" : ""}`}
                onClick={() => patchParams({ unassigned: "1", mailbox: null, thread: null, folder: "all" })}
                title="Mail to addresses that have no mailbox yet"
              >
                <AlertTriangle size={14} />
                <span>Unassigned</span>
                <span className="em-count muted-count">{overview?.summary.unassigned}</span>
              </button>
            )}
            {overview && (
              <div className="em-rail-stats">
                <span>
                  <ArrowDownLeft size={12} /> {overview.stats.received_7d} in
                </span>
                <span>
                  <ArrowUpRight size={12} /> {overview.stats.sent_7d} out
                </span>
                <span className="muted">last 7 days</span>
              </div>
            )}
          </aside>

          <section className="em-list">
            <div className="em-list-head">
              <div className="em-search">
                <Search size={14} />
                <input placeholder="Search mail…" value={q} onChange={(e) => setQ(e.target.value)} />
                {q && (
                  <button className="em-icon-btn" onClick={() => setQ("")} aria-label="Clear search">
                    <X size={13} />
                  </button>
                )}
              </div>
              <button className="em-icon-btn" onClick={() => reloadRef.current()} aria-label="Refresh">
                <RotateCw size={14} />
              </button>
            </div>
            <div className="em-list-sub muted tiny">
              {total} conversation{total === 1 ? "" : "s"}
            </div>
            <div className="em-threads">
              {threadsLoading && threads.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => <div key={i} className="em-skel" />)
              ) : threads.length === 0 ? (
                <EmptyList
                  hasMailboxes={mailboxes.length > 0}
                  searching={Boolean(debouncedQ)}
                  onSetup={() => setView(mailboxes.length ? "setup" : "mailboxes")}
                />
              ) : (
                threads.map((t) => (
                  <button
                    key={t.id}
                    className={`em-thread ${selectedId === t.id ? "selected" : ""} ${t.unread_count > 0 ? "unread" : ""}`}
                    onClick={() => patchParams({ thread: t.id })}
                  >
                    <Avatar name={t.counterparty_name} address={t.counterparty} />
                    <div className="em-thread-main">
                      <div className="em-thread-top">
                        <span className="em-thread-who em-ellipsis">{t.counterparty_name || t.counterparty}</span>
                        {t.message_count > 1 && <span className="em-thread-n">{t.message_count}</span>}
                        <span className="em-thread-time">{shortStamp(t.last_message_at)}</span>
                      </div>
                      <div className="em-thread-subject em-ellipsis">
                        {t.starred && <Star size={11} className="em-star-on" />}
                        {t.subject}
                      </div>
                      <div className="em-thread-snippet em-ellipsis">
                        {t.last_direction === "out" && <Undo2 size={11} className="muted" />}
                        {t.last_snippet || <span className="muted">(no text)</span>}
                      </div>
                      {!serviceScope && (t.service_name || !t.mailbox_id) && (
                        <div className="em-thread-tags">
                          {t.service_name ? (
                            <span className="em-tag">{t.service_name}</span>
                          ) : (
                            <span className="em-tag warn">unassigned · {t.local_address}</span>
                          )}
                        </div>
                      )}
                    </div>
                    {t.unread_count > 0 && <span className="em-dot" aria-label="unread" />}
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="em-reader">
            {selectedId ? (
              <Conversation
                key={selectedId}
                threadId={selectedId}
                refreshTick={refreshTick}
                smtpConfigured={Boolean(overview?.smtp.configured)}
                onBack={() => patchParams({ thread: null })}
                onChanged={() => {
                  void loadThreads();
                  void loadOverview();
                  void loadMailboxes();
                }}
                onDeleted={() => {
                  patchParams({ thread: null });
                  void loadThreads();
                  void loadOverview();
                }}
                onCreateMailbox={() => setView("mailboxes")}
              />
            ) : (
              <div className="em-reader-empty">
                <MailOpen size={34} />
                <p>Select a conversation</p>
                <span className="muted small">
                  {overview ? `${overview.summary.open} open · ${overview.summary.unread} unread` : ""}
                </span>
              </div>
            )}
          </section>
        </div>
      )}

      {view === "mailboxes" && (
        <MailboxesView
          mailboxes={scopedMailboxes}
          services={services}
          serviceScope={serviceScope}
          overview={overview}
          reload={() => {
            void loadMailboxes();
            void loadOverview();
          }}
        />
      )}

      {view === "setup" && (
        <SetupView
          overview={overview}
          mailboxes={mailboxes}
          reload={() => void loadOverview()}
          onOpenThread={(id) => patchParams({ view: null, thread: id, folder: null, mailbox: null })}
        />
      )}

      {composeOpen && (
        <ComposeModal
          mailboxes={mailboxes}
          serviceScope={serviceScope}
          smtpFrom={overview?.smtp.from ?? null}
          onClose={() => setComposeOpen(false)}
          onSent={(threadId) => {
            setComposeOpen(false);
            patchParams({ view: null, thread: threadId, folder: "sent", mailbox: null, unassigned: null });
            void loadThreads();
          }}
        />
      )}

      <EmailerStyles />
    </div>
  );
}

function EmptyList({ hasMailboxes, searching, onSetup }: { hasMailboxes: boolean; searching: boolean; onSetup: () => void }) {
  return (
    <div className="em-empty">
      <Inbox size={26} />
      {searching ? (
        <p>No conversations match your search.</p>
      ) : hasMailboxes ? (
        <>
          <p>No conversations here yet.</p>
          <button className="ghost small" onClick={onSetup}>
            Check inbound setup
          </button>
        </>
      ) : (
        <>
          <p>Add a mailbox to start receiving mail.</p>
          <button className="primary small" onClick={onSetup}>
            <Plus size={14} /> Add mailbox
          </button>
        </>
      )}
    </div>
  );
}

function ServiceStrip(props: {
  service: ServiceLite;
  mailboxes: Mailbox[];
  activeMailbox: string | null;
  onMailbox: (id: string | null) => void;
  onManage: () => void;
}) {
  const [stats, setStats] = useState<{ received_7d: number; sent_7d: number; failed_7d: number } | null>(null);
  useEffect(() => {
    api<{ received_7d: number; sent_7d: number; failed_7d: number }>(`/emailer/services/${props.service.id}/stats`, {
      silent: true
    })
      .then(setStats)
      .catch(() => setStats(null));
  }, [props.service.id]);
  return (
    <div className="em-service-strip">
      <div className="row" style={{ gap: "0.6rem", minWidth: 0, flexWrap: "wrap" }}>
        <Server size={15} className="text-accent" />
        <span className="font-bold">{props.service.name}</span>
        <span className={`em-status ${props.service.status}`}>{props.service.status}</span>
        {stats && (
          <span className="muted small">
            7d: {stats.received_7d} received · {stats.sent_7d} sent
            {stats.failed_7d ? <span className="text-danger"> · {stats.failed_7d} failed</span> : null}
          </span>
        )}
      </div>
      <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>
        {props.mailboxes.length === 0 ? (
          <span className="muted small">No mailbox routes mail to this service yet.</span>
        ) : (
          <>
            <button className={`em-chip ${!props.activeMailbox ? "active" : ""}`} onClick={() => props.onMailbox(null)}>
              all addresses
            </button>
            {props.mailboxes.map((m) => (
              <button
                key={m.id}
                className={`em-chip ${props.activeMailbox === m.id ? "active" : ""}`}
                onClick={() => props.onMailbox(m.id)}
              >
                {m.address}
                {m.unread > 0 && <span className="em-count">{m.unread}</span>}
              </button>
            ))}
          </>
        )}
        <button className="ghost xsmall" onClick={props.onManage}>
          <Settings2 size={12} /> Mailboxes
        </button>
        <Link className="button ghost xsmall" to={`/services/${props.service.id}/logs`}>
          <Terminal size={12} /> Logs
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function Conversation(props: {
  threadId: string;
  refreshTick: number;
  smtpConfigured: boolean;
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onCreateMailbox: () => void;
}) {
  const [data, setData] = useState<{ thread: Thread; messages: Message[] } | null>(null);
  const [error, setError] = useState(false);
  const [reply, setReply] = useState("");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const draftKey = `survhub_emailer_draft_${props.threadId}`;
  const { onChanged } = props;

  const load = useCallback(async () => {
    try {
      const res = await api<{ thread: Thread; messages: Message[] }>(`/emailer/threads/${props.threadId}`, {
        silent: true
      });
      setData(res);
      setError(false);
    } catch {
      setError(true);
    }
  }, [props.threadId]);

  useEffect(() => {
    void load().then(() => onChanged());
    try {
      setReply(localStorage.getItem(draftKey) ?? "");
    } catch {
      /* storage unavailable */
    }
  }, [props.threadId]);

  useEffect(() => {
    if (props.refreshTick > 0) void load();
  }, [props.refreshTick, load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length]);

  useEffect(() => {
    try {
      if (reply) localStorage.setItem(draftKey, reply);
      else localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }, [reply, draftKey]);

  if (error) {
    return (
      <div className="em-reader-empty">
        <AlertTriangle size={28} />
        <p>This conversation could not be loaded.</p>
        <button className="ghost small" onClick={props.onBack}>
          Back
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="em-reader-empty">
        <Loader2 size={24} className="spin" />
      </div>
    );
  }
  const { thread, messages } = data;

  async function patch(body: Record<string, unknown>, label: string): Promise<void> {
    setBusy(label);
    try {
      const updated = await api<Thread>(`/emailer/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setData((d) => (d ? { ...d, thread: updated } : d));
      props.onChanged();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    const ok = await confirmDialog({
      title: "Delete conversation?",
      message: `All ${thread.message_count} message(s) with ${thread.counterparty} are permanently removed from LocalSURV.`,
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/emailer/threads/${thread.id}`, { method: "DELETE" });
      toast.success("Conversation deleted");
      props.onDeleted();
    } catch {
      /* toasted */
    }
  }

  async function send(): Promise<void> {
    if (!reply.trim()) return;
    setSending(true);
    try {
      await api(`/emailer/threads/${thread.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ text: reply, cc: showCc && cc.trim() ? cc : undefined })
      });
      toast.success(`Reply sent to ${thread.counterparty}`);
      setReply("");
      setCc("");
      setShowCc(false);
    } catch {
      /* toasted — a failed send is still stored and can be retried */
    } finally {
      setSending(false);
      await load();
      props.onChanged();
    }
  }

  async function retry(m: Message): Promise<void> {
    setBusy(`retry-${m.id}`);
    try {
      await api(`/emailer/messages/${m.id}/retry`, { method: "POST", body: "{}" });
      toast.success("Sent");
      await load();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="em-convo">
      <header className="em-convo-head">
        <button className="em-icon-btn em-back" onClick={props.onBack} aria-label="Back to list">
          <ArrowLeft size={16} />
        </button>
        <div className="em-convo-title">
          <h3>{thread.subject}</h3>
          <div className="em-convo-sub">
            <span>
              {thread.counterparty_name ? `${thread.counterparty_name} <${thread.counterparty}>` : thread.counterparty}
            </span>
            <span className="muted">↔</span>
            <span className="em-mono">{thread.local_address}</span>
            {thread.service_name ? (
              <Link className="em-tag" to={`/emailer?service=${thread.service_id}`}>
                {thread.service_name}
              </Link>
            ) : !thread.mailbox_id ? (
              <button className="em-tag warn" onClick={props.onCreateMailbox} title="Create a mailbox for this address">
                unassigned — add mailbox
              </button>
            ) : null}
          </div>
        </div>
        <div className="em-convo-actions">
          {busy && <Loader2 size={14} className="spin muted" />}
          <button
            className={`em-icon-btn ${thread.starred ? "em-star-on" : ""}`}
            onClick={() => void patch({ starred: !thread.starred }, "star")}
            title={thread.starred ? "Unstar" : "Star"}
            aria-label="Star"
          >
            <Star size={15} />
          </button>
          <button className="em-icon-btn" onClick={() => void patch({ read: false }, "unread")} title="Mark unread" aria-label="Mark unread">
            <Mail size={15} />
          </button>
          {thread.status === "open" ? (
            <button className="em-icon-btn" onClick={() => void patch({ status: "archived" }, "archive")} title="Archive" aria-label="Archive">
              <Archive size={15} />
            </button>
          ) : (
            <button className="em-icon-btn" onClick={() => void patch({ status: "open" }, "open")} title="Move to inbox" aria-label="Move to inbox">
              <Inbox size={15} />
            </button>
          )}
          {thread.status !== "spam" && (
            <button className="em-icon-btn" onClick={() => void patch({ status: "spam" }, "spam")} title="Mark as spam" aria-label="Spam">
              <ShieldAlert size={15} />
            </button>
          )}
          <button className="em-icon-btn danger" onClick={() => void remove()} title="Delete" aria-label="Delete">
            <Trash2 size={15} />
          </button>
        </div>
      </header>

      <div className="em-messages">
        {messages.map((m) => (
          <MessageCard key={m.id} message={m} busy={busy === `retry-${m.id}`} onRetry={() => void retry(m)} />
        ))}
        <div ref={bottomRef} />
      </div>

      <footer className="em-reply">
        {!props.smtpConfigured ? (
          <div className="muted small">
            <AlertTriangle size={13} /> Replies need SMTP —{" "}
            <Link className="link" to="/email">
              configure it on the Email tab
            </Link>
            .
          </div>
        ) : (
          <>
            <div className="em-reply-meta">
              <span className="muted tiny">
                Reply to <b>{thread.counterparty}</b> from <b>{thread.local_address}</b>
              </span>
              {!showCc && (
                <button className="em-linkbtn tiny" onClick={() => setShowCc(true)}>
                  + Cc
                </button>
              )}
            </div>
            {showCc && (
              <input className="input em-cc" placeholder="Cc (comma separated)" value={cc} onChange={(e) => setCc(e.target.value)} />
            )}
            <textarea
              className="input em-reply-box"
              placeholder="Write a reply…  (Ctrl/⌘ + Enter to send)"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={4}
            />
            <div className="em-reply-actions">
              {reply && <span className="muted tiny">Draft saved</span>}
              <button className="primary small" disabled={sending || !reply.trim()} onClick={() => void send()}>
                {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send reply
              </button>
            </div>
          </>
        )}
      </footer>
    </div>
  );
}

function MessageCard({ message: m, busy, onRetry }: { message: Message; busy: boolean; onRetry: () => void }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const [mode, setMode] = useState<"text" | "html">(m.text_body ? "text" : m.html_body ? "html" : "text");
  const [remoteImages, setRemoteImages] = useState(false);
  const { body, quoted } = useMemo(() => splitQuoted(m.text_body ?? ""), [m.text_body]);
  const out = m.direction === "out";

  const srcDoc = useMemo(() => {
    if (!m.html_body) return "";
    // Sandboxed (no scripts, no same-origin) and, by default, no remote loads:
    // tracking pixels stay dark until the operator opts in per message.
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:${remoteImages ? " https: http:" : ""}; font-src data:`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{font-family:system-ui,sans-serif;font-size:14px;color:#111;background:#fff;margin:12px;word-break:break-word}img{max-width:100%;height:auto}</style></head><body>${m.html_body}</body></html>`;
  }, [m.html_body, remoteImages]);

  return (
    <article className={`em-msg ${out ? "out" : "in"} ${m.status === "failed" ? "failed" : ""}`}>
      <div className="em-msg-head">
        <Avatar name={m.from_name} address={m.from_addr} size={28} />
        <div className="em-msg-who">
          <span className="font-bold">{m.from_name || m.from_addr}</span>
          <span className="muted tiny em-ellipsis">
            {m.from_name ? `<${m.from_addr}> ` : ""}to {m.to.map((a) => a.address).join(", ")}
            {m.cc.length > 0 && ` · cc ${m.cc.map((a) => a.address).join(", ")}`}
          </span>
        </div>
        <div className="em-msg-meta">
          {out ? (
            <span className="em-dir out" title={`Sent via ${m.source}`}>
              <ArrowUpRight size={12} /> {m.source === "api" ? "app" : m.source === "dashboard" ? "you" : m.source}
            </span>
          ) : (
            <span className="em-dir in">
              <ArrowDownLeft size={12} /> received
            </span>
          )}
          <span className="muted tiny" title={new Date(m.created_at).toLocaleString()}>
            {timeAgo(m.created_at)}
          </span>
        </div>
      </div>

      {m.html_body && m.text_body && (
        <div className="em-msg-modes">
          <button className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>
            <FileText size={11} /> Text
          </button>
          <button className={mode === "html" ? "active" : ""} onClick={() => setMode("html")}>
            <Eye size={11} /> HTML
          </button>
        </div>
      )}

      {mode === "html" && m.html_body ? (
        <div className="em-html">
          <iframe title={`Message ${m.id}`} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcDoc} />
          <button className="em-linkbtn tiny" onClick={() => setRemoteImages((v) => !v)}>
            {remoteImages ? <EyeOff size={11} /> : <Eye size={11} />} {remoteImages ? "Block" : "Load"} remote images
          </button>
        </div>
      ) : (
        <div className="em-msg-body">
          {body || <span className="muted">(empty message)</span>}
          {quoted && (
            <>
              <button className="em-quoted-toggle" onClick={() => setShowQuoted((v) => !v)} title="Show quoted text">
                •••
              </button>
              {showQuoted && <div className="em-quoted">{quoted}</div>}
            </>
          )}
        </div>
      )}

      {m.attachments.length > 0 && (
        <div className="em-attachments">
          {m.attachments.map((a, i) => (
            <span key={i} className="em-attachment" title={`${a.contentType} — content not stored`}>
              <Paperclip size={11} /> {a.filename} <span className="muted">{formatBytes(a.size)}</span>
            </span>
          ))}
        </div>
      )}

      {(m.status === "failed" || m.forward_status) && (
        <div className="em-msg-foot">
          {m.status === "failed" && (
            <span className="text-danger small">
              <AlertTriangle size={12} /> Not delivered: {m.error ?? "unknown error"}{" "}
              <button className="ghost xsmall" disabled={busy} onClick={onRetry}>
                {busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Retry
              </button>
            </span>
          )}
          {m.forward_status && (
            <span className={`tiny ${m.forward_status.startsWith("delivered") ? "muted" : "text-warning"}`}>
              <Zap size={11} /> service webhook: {m.forward_status}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

function ComposeModal(props: {
  mailboxes: Mailbox[];
  serviceScope: string | null;
  smtpFrom: string | null;
  onClose: () => void;
  onSent: (threadId: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initial =
    props.mailboxes.find((m) => m.service_id === props.serviceScope && !m.wildcard) ??
    props.mailboxes.find((m) => m.service_id === props.serviceScope) ??
    props.mailboxes.find((m) => !m.wildcard) ??
    null;
  const [mailboxId, setMailboxId] = useState<string>(initial?.id ?? "");
  const [localPart, setLocalPart] = useState("hello");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  useModalA11y(dialogRef, { onClose: props.onClose });

  const mailbox = props.mailboxes.find((m) => m.id === mailboxId) ?? null;

  async function send(): Promise<void> {
    setSending(true);
    try {
      const res = await api<{ thread: { id: string } }>("/emailer/send", {
        method: "POST",
        body: JSON.stringify({
          mailboxId: mailboxId || null,
          from: mailbox?.wildcard ? `${localPart.trim()}${mailbox.address.slice(1)}` : undefined,
          to,
          cc: cc.trim() ? cc : undefined,
          subject,
          text
        })
      });
      toast.success("Message sent");
      props.onSent(res.thread.id);
    } catch {
      /* toasted */
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div
        ref={dialogRef}
        className="modal-content em-compose"
        role="dialog"
        aria-modal="true"
        aria-labelledby="em-compose-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3 id="em-compose-title">New message</h3>
          <button className="ghost icon-only" onClick={props.onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body em-form">
          <label>
            <span className="tiny uppercase font-bold muted">From</span>
            <div className="row" style={{ gap: "0.4rem" }}>
              <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)} style={{ flex: 1 }}>
                <option value="">{props.smtpFrom ? `${props.smtpFrom} (shared default)` : "Shared default From"}</option>
                {props.mailboxes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.address}
                    {m.service_name ? ` — ${m.service_name}` : ""}
                  </option>
                ))}
              </select>
              {mailbox?.wildcard && (
                <span className="row" style={{ gap: 0, alignItems: "center" }}>
                  <input style={{ width: 110 }} value={localPart} onChange={(e) => setLocalPart(e.target.value)} />
                  <span className="em-mono muted">{mailbox.address.slice(1)}</span>
                </span>
              )}
            </div>
          </label>
          <label>
            <span className="tiny uppercase font-bold muted">To</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@example.com" />
          </label>
          <label>
            <span className="tiny uppercase font-bold muted">Cc</span>
            <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="optional, comma separated" />
          </label>
          <label>
            <span className="tiny uppercase font-bold muted">Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label>
            <span className="tiny uppercase font-bold muted">Message</span>
            <textarea
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </label>
          {mailbox?.signature && <span className="muted tiny">The mailbox signature is appended automatically.</span>}
        </div>
        <footer className="modal-footer">
          <button className="ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button className="primary" disabled={sending || !to.trim() || !subject.trim() || !text.trim()} onClick={() => void send()}>
            {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

function MailboxesView(props: {
  mailboxes: Mailbox[];
  services: ServiceLite[];
  serviceScope: string | null;
  overview: Overview | null;
  reload: () => void;
}) {
  const [editing, setEditing] = useState<Mailbox | "new" | null>(null);
  const [token, setToken] = useState<{ mailbox: Mailbox; token: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();

  async function act<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(key);
    try {
      return await fn();
    } catch {
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function mintToken(m: Mailbox): Promise<void> {
    if (m.has_api_token) {
      const ok = await confirmDialog({
        title: "Rotate API token?",
        message: "The current token stops working immediately. Anything sending with it must be updated.",
        confirmLabel: "Rotate"
      });
      if (!ok) return;
    }
    const res = await act(`token-${m.id}`, () =>
      api<{ token: string; mailbox: Mailbox }>(`/emailer/mailboxes/${m.id}/token`, { method: "POST", body: "{}" })
    );
    if (res) {
      setToken({ mailbox: res.mailbox, token: res.token });
      props.reload();
    }
  }

  async function injectEnv(m: Mailbox): Promise<void> {
    const ok = await confirmDialog({
      title: `Connect ${m.service_name ?? "service"} to this mailbox?`,
      message:
        "Mints a fresh mailbox token (replacing any existing one) and writes EMAILER_API_URL, EMAILER_API_TOKEN and EMAILER_FROM into the service's env. Restart the service to pick them up.",
      confirmLabel: "Write env"
    });
    if (!ok) return;
    const res = await act(`inject-${m.id}`, () =>
      api<{ message: string }>(`/emailer/mailboxes/${m.id}/inject-env`, { method: "POST", body: "{}" })
    );
    if (res) {
      toast.success(res.message);
      props.reload();
    }
  }

  async function routeCloudflare(m: Mailbox): Promise<void> {
    const res = await act(`cf-${m.id}`, () =>
      api<{ zone: string; rule: string }>(`/emailer/mailboxes/${m.id}/cloudflare-route`, { method: "POST", body: "{}" })
    );
    if (res) toast.success(`${res.rule === "catch_all" ? "Catch-all" : res.rule} on ${res.zone} now routes to the Emailer relay`);
  }

  async function remove(m: Mailbox): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete ${m.address}?`,
      message: "Its conversations are kept (as unassigned). Mail to this address stops being routed to a service, and its API token stops working.",
      confirmLabel: "Delete mailbox",
      danger: true
    });
    if (!ok) return;
    const res = await act(`rm-${m.id}`, () => api(`/emailer/mailboxes/${m.id}`, { method: "DELETE" }));
    if (res) {
      toast.success("Mailbox deleted");
      props.reload();
    }
  }

  return (
    <section className="card">
      <div className="section-title">
        <h3>
          <AtSign size={15} /> Mailboxes
        </h3>
        <button className="primary small" onClick={() => setEditing("new")}>
          <Plus size={14} /> New mailbox
        </button>
      </div>
      <p className="muted small">
        A mailbox is one of your addresses (or <code>*@domain</code> for everything on a domain). Link it to a service to
        give that service its own inbox; optionally forward each inbound message to the service as a webhook, or let
        the service send through the Emailer API so its outbound mail shows up in the same conversations.
      </p>

      {props.mailboxes.length === 0 ? (
        <div className="em-empty">
          <AtSign size={24} />
          <p>No mailboxes{props.serviceScope ? " for this service" : ""} yet.</p>
        </div>
      ) : (
        <div className="em-mailboxes">
          {props.mailboxes.map((m) => (
            <div key={m.id} className="em-mailbox">
              <div className="em-mailbox-main">
                <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                  <span className="em-mono font-bold">{m.address}</span>
                  {m.display_name && <span className="muted small">“{m.display_name}”</span>}
                  {m.wildcard && <span className="em-tag">catch-all</span>}
                </div>
                <div className="em-mailbox-facts">
                  <span>
                    <Server size={12} />{" "}
                    {m.service_name ? (
                      <Link className="link" to={`/emailer?service=${m.service_id}`}>
                        {m.service_name}
                      </Link>
                    ) : (
                      <span className="muted">no service</span>
                    )}
                  </span>
                  <span>
                    <Inbox size={12} /> {m.threads} conversations{m.unread ? ` · ${m.unread} unread` : ""}
                  </span>
                  <span title={m.forward_url ?? ""}>
                    <Zap size={12} /> {m.forward_url ? <span className="em-mono">{m.forward_url}</span> : <span className="muted">no webhook</span>}
                  </span>
                  <span>
                    <KeyRound size={12} />{" "}
                    {m.has_api_token ? <span className="em-mono">{m.api_token_prefix}…</span> : <span className="muted">no API token</span>}
                  </span>
                </div>
              </div>
              <div className="em-mailbox-actions">
                <button className="ghost xsmall" onClick={() => navigate(`/emailer?mailbox=${m.id}&folder=all`)}>
                  <Inbox size={12} /> Open
                </button>
                {!m.wildcard && (
                  <button className="ghost xsmall" disabled={busy !== null} onClick={() => void mintToken(m)}>
                    {busy === `token-${m.id}` ? <Loader2 size={12} className="spin" /> : <KeyRound size={12} />}{" "}
                    {m.has_api_token ? "Rotate token" : "API token"}
                  </button>
                )}
                {!m.wildcard && m.service_id && (
                  <button className="ghost xsmall" disabled={busy !== null} onClick={() => void injectEnv(m)}>
                    {busy === `inject-${m.id}` ? <Loader2 size={12} className="spin" /> : <Server size={12} />} Connect service
                  </button>
                )}
                {props.overview?.cloudflare.connected && (
                  <button className="ghost xsmall" disabled={busy !== null} onClick={() => void routeCloudflare(m)} title="Route this address to the Cloudflare relay Worker">
                    {busy === `cf-${m.id}` ? <Loader2 size={12} className="spin" /> : <Cloud size={12} />} Route
                  </button>
                )}
                <button className="ghost xsmall" onClick={() => setEditing(m)} aria-label="Edit mailbox">
                  <Pencil size={12} />
                </button>
                <button className="ghost xsmall text-danger" disabled={busy !== null} onClick={() => void remove(m)} aria-label="Delete mailbox">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <MailboxModal
          mailbox={editing === "new" ? null : editing}
          services={props.services}
          defaultServiceId={props.serviceScope}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            props.reload();
          }}
        />
      )}
      {token && (
        <TokenModal
          mailbox={token.mailbox}
          token={token.token}
          apiUrl={props.overview?.apiUrl ?? "/emailer/api"}
          onClose={() => setToken(null)}
        />
      )}
    </section>
  );
}

function MailboxModal(props: {
  mailbox: Mailbox | null;
  services: ServiceLite[];
  defaultServiceId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const m = props.mailbox;
  const [address, setAddress] = useState(m?.address ?? "");
  const [displayName, setDisplayName] = useState(m?.display_name ?? "");
  const [serviceId, setServiceId] = useState(m?.service_id ?? props.defaultServiceId ?? "");
  const [forwardUrl, setForwardUrl] = useState(m?.forward_url ?? "");
  const [signature, setSignature] = useState(m?.signature ?? "");
  const [saving, setSaving] = useState(false);
  useModalA11y(dialogRef, { onClose: props.onClose });

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const body = JSON.stringify({ address, displayName, serviceId: serviceId || null, forwardUrl, signature });
      if (m) await api(`/emailer/mailboxes/${m.id}`, { method: "PATCH", body });
      else await api("/emailer/mailboxes", { method: "POST", body });
      toast.success(m ? "Mailbox updated" : "Mailbox created");
      props.onSaved();
    } catch {
      /* toasted */
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div
        ref={dialogRef}
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="em-mb-title"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560 }}
      >
        <header className="modal-header">
          <h3 id="em-mb-title">{m ? "Edit mailbox" : "New mailbox"}</h3>
          <button className="ghost icon-only" onClick={props.onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body em-form">
          <label>
            <span className="tiny uppercase font-bold muted">Address</span>
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="support@yourapp.com  or  *@yourapp.com" />
          </label>
          <label>
            <span className="tiny uppercase font-bold muted">Display name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your App Support" />
          </label>
          <label>
            <span className="tiny uppercase font-bold muted">Service</span>
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">— none —</option>
              {props.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <span className="muted tiny">Conversations for this address appear in the service's inbox.</span>
          </label>
          <label>
            <span className="tiny uppercase font-bold muted">Forward inbound to webhook (optional)</span>
            <input value={forwardUrl} onChange={(e) => setForwardUrl(e.target.value)} placeholder="http://127.0.0.1:3000/api/inbound-email" />
            <span className="muted tiny">Each received message is POSTed as JSON (event email.received) to your service.</span>
          </label>
          <label>
            <span className="tiny uppercase font-bold muted">Signature (optional)</span>
            <textarea rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={"Best regards,\nThe Team"} />
          </label>
        </div>
        <footer className="modal-footer">
          <button className="ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button className="primary" disabled={saving || !address.trim()} onClick={() => void save()}>
            {saving && <Loader2 size={14} className="spin" />} {m ? "Save" : "Create mailbox"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function TokenModal(props: { mailbox: Mailbox; token: string; apiUrl: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, { onClose: props.onClose });
  const snippet = `curl -X POST ${props.apiUrl}/send \\
  -H "Authorization: Bearer ${props.token}" \\
  -H "content-type: application/json" \\
  -d '{"to":"customer@example.com","subject":"Your order","text":"Thanks for ordering!"}'`;
  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div
        ref={dialogRef}
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="em-tok-title"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 640 }}
      >
        <header className="modal-header">
          <h3 id="em-tok-title">API token for {props.mailbox.address}</h3>
        </header>
        <div className="modal-body em-form">
          <div className="em-banner warn" style={{ margin: 0 }}>
            <KeyRound size={14} /> Shown once — copy it now. Only a hash is stored.
          </div>
          <div className="em-secret">
            <code>{props.token}</code>
            <button className="ghost xsmall" onClick={() => void copyText(props.token, "Token copied")}>
              <Copy size={12} /> Copy
            </button>
          </div>
          <span className="tiny uppercase font-bold muted">Send from your app</span>
          <pre className="em-code">{snippet}</pre>
          <span className="muted tiny">
            Optional fields: <code>cc</code>, <code>html</code>, and <code>threadId</code> (to reply inside an existing
            conversation of this mailbox).
          </span>
        </div>
        <footer className="modal-footer">
          <button className="ghost" onClick={() => void copyText(snippet, "Example copied")}>
            <Copy size={14} /> Copy example
          </button>
          <button className="primary" onClick={props.onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function SetupStep({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <section className={`card em-step ${done ? "done" : ""}`}>
      <div className="em-step-head">
        <span className="em-step-n">{done ? <CheckCircle2 size={16} /> : n}</span>
        <h3>{title}</h3>
      </div>
      <div className="em-step-body">{children}</div>
    </section>
  );
}

function SetupView(props: {
  overview: Overview | null;
  mailboxes: Mailbox[];
  reload: () => void;
  onOpenThread: (id: string) => void;
}) {
  const o = props.overview;
  const [publicUrl, setPublicUrl] = useState(o?.publicUrl ?? "");
  const [ingest, setIngest] = useState<{ url: string; token: string; workerScript: string; curlExample: string } | null>(null);
  const [reveal, setReveal] = useState(false);
  const [fallback, setFallback] = useState("");
  const [simTo, setSimTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setPublicUrl(o?.publicUrl ?? "");
  }, [o?.publicUrl]);

  const loadIngest = useCallback(async () => {
    try {
      setIngest(await api("/emailer/ingest", { silent: true }));
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void loadIngest();
  }, [loadIngest]);

  useEffect(() => {
    if (!simTo && props.mailboxes.length) {
      const m = props.mailboxes.find((x) => !x.wildcard) ?? props.mailboxes[0];
      setSimTo(m.wildcard ? `hello${m.address.slice(1)}` : m.address);
    }
  }, [props.mailboxes, simTo]);

  async function act(key: string, fn: () => Promise<void>): Promise<void> {
    setBusy(key);
    try {
      await fn();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  }

  const loopback = !o?.publicUrl && /127\.0\.0\.1|localhost/.test(ingest?.url ?? "");

  return (
    <div className="em-setup">
      <SetupStep n={1} title="Outbound: shared SMTP" done={o?.smtp.configured}>
        {o?.smtp.configured ? (
          <p className="muted small">
            Sending through the shared SMTP from the Email tab. Default From: <b>{o.smtp.from}</b>. Mailboxes send as
            their own address.
          </p>
        ) : (
          <p className="muted small">Replies and new messages are sent through the shared SMTP credentials.</p>
        )}
        <Link className="button ghost small" to="/email">
          <Server size={14} /> {o?.smtp.configured ? "SMTP settings" : "Configure SMTP"}
        </Link>
      </SetupStep>

      <SetupStep n={2} title="Mailboxes" done={props.mailboxes.length > 0}>
        <p className="muted small">
          {props.mailboxes.length
            ? `${props.mailboxes.length} mailbox${props.mailboxes.length === 1 ? "" : "es"} configured.`
            : "Create a mailbox for each address you want to receive on, and link it to its service."}
        </p>
      </SetupStep>

      <SetupStep n={3} title="Inbound endpoint" done={Boolean(o?.publicUrl)}>
        <p className="muted small">
          Mail reaches LocalSURV as an HTTPS POST to the ingest endpoint. Set the public https URL of this control plane
          (via a tunnel or Edge Ingress) so relays on the internet can reach it.
        </p>
        <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 260px" }}
            placeholder="https://hoster.yourdomain.com"
            value={publicUrl}
            onChange={(e) => setPublicUrl(e.target.value)}
          />
          <button
            className="primary small"
            disabled={busy !== null || publicUrl.trim() === (o?.publicUrl ?? "")}
            onClick={() =>
              void act("url", async () => {
                await api("/emailer/settings", { method: "PUT", body: JSON.stringify({ publicUrl: publicUrl.trim() }) });
                toast.success("Public URL saved");
                props.reload();
                await loadIngest();
              })
            }
          >
            {busy === "url" && <Loader2 size={14} className="spin" />} Save
          </button>
        </div>
        {ingest && (
          <div className="em-kv">
            <span className="tiny uppercase font-bold muted">Ingest URL</span>
            <div className="em-secret">
              <code>{ingest.url}</code>
              <button className="ghost xsmall" onClick={() => void copyText(ingest.url, "URL copied")}>
                <Copy size={12} />
              </button>
            </div>
            {loopback && (
              <span className="text-warning tiny">
                <AlertTriangle size={11} /> This is a loopback address — only relays on this machine can reach it.
              </span>
            )}
            <span className="tiny uppercase font-bold muted">Ingest token (header x-emailer-token)</span>
            <div className="em-secret">
              <code>{reveal ? ingest.token : `${ingest.token.slice(0, 8)}${"•".repeat(24)}`}</code>
              <button className="ghost xsmall" onClick={() => setReveal((v) => !v)} aria-label={reveal ? "Hide token" : "Reveal token"}>
                {reveal ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
              <button className="ghost xsmall" onClick={() => void copyText(ingest.token, "Token copied")}>
                <Copy size={12} />
              </button>
              <button
                className="ghost xsmall text-danger"
                disabled={busy !== null}
                onClick={() =>
                  void act("rotate", async () => {
                    const ok = await confirmDialog({
                      title: "Rotate ingest token?",
                      message: "Relays using the old token are rejected until updated (redeploy the Cloudflare Worker below).",
                      confirmLabel: "Rotate",
                      danger: true
                    });
                    if (!ok) return;
                    await api("/emailer/ingest/rotate", { method: "POST", body: "{}" });
                    toast.success("Ingest token rotated");
                    await loadIngest();
                  })
                }
              >
                <RefreshCw size={12} /> Rotate
              </button>
            </div>
          </div>
        )}
      </SetupStep>

      <SetupStep n={4} title="Relay: Cloudflare Email Routing (recommended)">
        <p className="muted small">
          A tiny Cloudflare Email Worker receives mail for your domain and posts the raw message to the ingest
          endpoint. If LocalSURV is unreachable it forwards to a fallback inbox (when set) or asks the sender to retry, so
          nothing is lost.
        </p>
        {o?.cloudflare.connected ? (
          <>
            <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
              <input
                className="input"
                style={{ flex: "1 1 240px" }}
                placeholder="Fallback inbox (optional) — e.g. you@gmail.com"
                value={fallback}
                onChange={(e) => setFallback(e.target.value)}
              />
              <button
                className="primary small"
                disabled={busy !== null}
                onClick={() =>
                  void act("worker", async () => {
                    const res = await api<{ script: string; ingestUrl: string }>("/emailer/cloudflare/worker", {
                      method: "POST",
                      body: JSON.stringify({ fallbackForward: fallback.trim() || null })
                    });
                    toast.success(`Worker "${res.script}" deployed → ${res.ingestUrl}`);
                  })
                }
              >
                {busy === "worker" ? <Loader2 size={14} className="spin" /> : <Cloud size={14} />} Deploy relay Worker
              </button>
            </div>
            <p className="muted tiny">
              Then use <b>Route</b> on each mailbox (Mailboxes tab) to point its address — or the catch-all for{" "}
              <code>*@domain</code> — at the Worker. The token needs <i>Workers Scripts: Edit</i> and{" "}
              <i>Email Routing Rules: Edit</i>.
            </p>
          </>
        ) : (
          <p className="muted small">
            <AlertTriangle size={12} /> Connect Cloudflare (token + account id) under{" "}
            <Link className="link" to="/email">
              Email → Receiving
            </Link>{" "}
            for one-click deploy, or paste the script below into a new Worker yourself.
          </p>
        )}
        {ingest && (
          <details className="em-details">
            <summary>Worker script (manual setup)</summary>
            <pre className="em-code">{ingest.workerScript}</pre>
            <button className="ghost xsmall" onClick={() => void copyText(ingest.workerScript, "Worker script copied")}>
              <Copy size={12} /> Copy script
            </button>
          </details>
        )}
      </SetupStep>

      <SetupStep n={5} title="Any other relay">
        <p className="muted small">
          Anything that can POST JSON works (n8n, a mail-to-webhook service, your own code). Send either{" "}
          <code>rawBase64</code> / <code>raw</code> (the full RFC 822 message) or the parsed fields <code>from</code>,{" "}
          <code>to</code>, <code>subject</code>, <code>text</code>, <code>html</code>, <code>messageId</code>,{" "}
          <code>inReplyTo</code>. A bare <code>message/rfc822</code> body is accepted too.
        </p>
        {ingest && <pre className="em-code">{ingest.curlExample}</pre>}
      </SetupStep>

      <SetupStep n={6} title="Test routing">
        <p className="muted small">
          Simulate an inbound message (no DNS involved) to check which service it lands on, and that n8n / service
          webhooks fire.
        </p>
        <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 240px" }}
            placeholder="support@yourapp.com"
            value={simTo}
            onChange={(e) => setSimTo(e.target.value)}
            list="em-sim-to"
          />
          <datalist id="em-sim-to">
            {props.mailboxes.filter((m) => !m.wildcard).map((m) => (
              <option key={m.id} value={m.address} />
            ))}
          </datalist>
          <button
            className="ghost small"
            disabled={busy !== null || !simTo.trim()}
            onClick={() =>
              void act("sim", async () => {
                const res = await api<{ thread_id: string; mailbox: string | null }>("/emailer/inbound/simulate", {
                  method: "POST",
                  body: JSON.stringify({ to: simTo.trim() })
                });
                toast.success(res.mailbox ? `Delivered to ${res.mailbox}` : "Delivered — no mailbox matched (unassigned)");
                props.onOpenThread(res.thread_id);
              })
            }
          >
            {busy === "sim" ? <Loader2 size={14} className="spin" /> : <ArrowDownLeft size={14} />} Simulate inbound
          </button>
        </div>
      </SetupStep>

      <SetupStep n={7} title="Automate with n8n">
        <p className="muted small">
          Install the <code>email.received</code> / <code>email.sent</code> events on the n8n tab to triage, auto-reply
          or route mail with workflows. Workflows can send mail back through a mailbox token.
        </p>
        <Link className="button ghost small" to="/n8n?tab=automations">
          <Zap size={14} /> n8n events
        </Link>
      </SetupStep>
    </div>
  );
}

function EmailerStyles() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
  .emailer-page .em-scope { min-width: 170px; }
  .emailer-page .em-banner { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; padding: 0.6rem 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-default); margin-bottom: 1rem; font-size: 0.85rem; color: var(--text-primary); }
  .emailer-page .em-banner.warn { background: var(--warning-soft); border-color: rgba(245, 158, 11, 0.35); }
  .emailer-page .em-banner.warn > svg { color: var(--warning); }
  .emailer-page .em-banner .button { margin-left: auto; }
  .emailer-page .em-tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border-default); margin-bottom: 1rem; overflow-x: auto; }
  .emailer-page .em-tab { display: inline-flex; align-items: center; gap: 0.4rem; background: none; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 0.6rem 0.8rem; color: var(--text-secondary); font-size: 0.85rem; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .emailer-page .em-tab:hover { color: var(--text-primary); }
  .emailer-page .em-tab.active { color: var(--text-primary); border-bottom-color: var(--accent); }
  .emailer-page .em-count { margin-left: auto; font-size: 0.68rem; font-weight: 700; min-width: 1.3rem; text-align: center; padding: 0.05rem 0.4rem; border-radius: var(--radius-full); background: var(--accent); color: #fff; }
  .emailer-page .em-tab .em-count { margin-left: 0.15rem; }
  .emailer-page .em-count.muted-count { background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border-default); }
  .emailer-page .em-service-strip { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; padding: 0.7rem 0.9rem; margin-bottom: 1rem; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-card); }
  .emailer-page .em-status { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; padding: 0.05rem 0.4rem; border-radius: var(--radius-full); background: var(--bg-elevated); color: var(--text-muted); }
  .emailer-page .em-status.running { background: var(--success-soft); color: var(--success); }
  .emailer-page .em-chip { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: var(--radius-full); border: 1px solid var(--border-default); background: var(--bg-sunken); color: var(--text-secondary); cursor: pointer; font-family: var(--font-mono); }
  .emailer-page .em-chip.active { border-color: var(--accent); color: var(--accent-light); background: var(--accent-soft); }
  .emailer-page .em-chip .em-count { margin-left: 0; }

  .emailer-page .em-shell { display: grid; grid-template-columns: 210px minmax(260px, 360px) minmax(0, 1fr); height: calc(100vh - 230px); min-height: 520px; border: 1px solid var(--border-default); border-radius: var(--radius-lg); background: var(--bg-card); overflow: hidden; }
  .emailer-page .em-rail { border-right: 1px solid var(--border-default); padding: 0.6rem 0.4rem; overflow-y: auto; display: flex; flex-direction: column; gap: 0.1rem; }
  .emailer-page .em-rail-item { display: flex; align-items: center; gap: 0.55rem; width: 100%; padding: 0.42rem 0.6rem; border: none; border-radius: var(--radius-sm); background: none; color: var(--text-secondary); font-size: 0.83rem; text-align: left; cursor: pointer; min-width: 0; }
  .emailer-page .em-rail-item:hover { background: var(--bg-glass); color: var(--text-primary); }
  .emailer-page .em-rail-item.active { background: var(--accent-soft); color: var(--accent-light); font-weight: 600; }
  .emailer-page .em-rail-item.muted { color: var(--text-muted); }
  .emailer-page .em-rail-heading { margin: 0.9rem 0.6rem 0.3rem; font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
  .emailer-page .em-rail-stats { margin-top: auto; padding: 0.75rem 0.6rem 0.25rem; display: flex; flex-wrap: wrap; gap: 0.25rem 0.6rem; font-size: 0.72rem; color: var(--text-secondary); }
  .emailer-page .em-rail-stats span { display: inline-flex; align-items: center; gap: 0.2rem; }
  .emailer-page .em-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  .emailer-page .em-list { border-right: 1px solid var(--border-default); display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .emailer-page .em-list-head { display: flex; gap: 0.4rem; align-items: center; padding: 0.6rem; border-bottom: 1px solid var(--border-subtle); }
  .emailer-page .em-list-sub { padding: 0.35rem 0.8rem; border-bottom: 1px solid var(--border-subtle); }
  .emailer-page .em-search { flex: 1; display: flex; align-items: center; gap: 0.4rem; padding: 0 0.55rem; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-sunken); }
  .emailer-page .em-search input { flex: 1; border: none; background: transparent; padding: 0.42rem 0; outline: none; min-width: 0; }
  .emailer-page .em-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 1px solid transparent; border-radius: var(--radius-sm); background: none; color: var(--text-secondary); cursor: pointer; padding: 0; flex-shrink: 0; }
  .emailer-page .em-icon-btn:hover { background: var(--bg-glass); color: var(--text-primary); border-color: var(--border-default); }
  .emailer-page .em-icon-btn.danger:hover { color: var(--danger); }
  .emailer-page .em-search .em-icon-btn { width: 22px; height: 22px; }
  .emailer-page .em-threads { overflow-y: auto; flex: 1; }
  .emailer-page .em-thread { display: flex; gap: 0.6rem; align-items: flex-start; width: 100%; padding: 0.7rem 0.8rem; border: none; border-bottom: 1px solid var(--border-subtle); border-left: 3px solid transparent; background: none; text-align: left; cursor: pointer; color: inherit; position: relative; }
  .emailer-page .em-thread:hover { background: var(--bg-glass); }
  .emailer-page .em-thread.selected { background: var(--accent-soft); border-left-color: var(--accent); }
  .emailer-page .em-thread-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.12rem; }
  .emailer-page .em-thread-top { display: flex; align-items: center; gap: 0.4rem; }
  .emailer-page .em-thread-who { font-size: 0.85rem; color: var(--text-secondary); flex: 1; }
  .emailer-page .em-thread.unread .em-thread-who, .emailer-page .em-thread.unread .em-thread-subject { color: var(--text-primary); font-weight: 700; }
  .emailer-page .em-thread-n { font-size: 0.68rem; color: var(--text-muted); }
  .emailer-page .em-thread-time { font-size: 0.7rem; color: var(--text-muted); white-space: nowrap; }
  .emailer-page .em-thread-subject { font-size: 0.82rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.25rem; }
  .emailer-page .em-thread-snippet { font-size: 0.76rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.25rem; }
  .emailer-page .em-thread-tags { margin-top: 0.2rem; }
  .emailer-page .em-tag { display: inline-flex; align-items: center; font-size: 0.66rem; font-weight: 600; padding: 0.05rem 0.45rem; border-radius: var(--radius-full); background: var(--bg-elevated); border: 1px solid var(--border-default); color: var(--text-secondary); text-decoration: none; cursor: pointer; white-space: nowrap; }
  .emailer-page .em-tag.warn { background: var(--warning-soft); border-color: rgba(245, 158, 11, 0.35); color: var(--warning); }
  .emailer-page .em-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex-shrink: 0; margin-top: 0.4rem; }
  .emailer-page .em-star-on { color: #f5b301 !important; fill: #f5b301; }
  .emailer-page .em-avatar { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: #fff; font-weight: 700; flex-shrink: 0; letter-spacing: 0.02em; }
  .emailer-page .em-skel { height: 64px; margin: 0.5rem 0.8rem; border-radius: var(--radius-md); background: linear-gradient(90deg, var(--bg-sunken) 25%, var(--bg-glass) 50%, var(--bg-sunken) 75%); background-size: 200% 100%; animation: em-shimmer 1.4s ease-in-out infinite; }
  @keyframes em-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  .emailer-page .em-empty { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; padding: 2.5rem 1rem; color: var(--text-muted); text-align: center; }
  .emailer-page .em-empty p { margin: 0; }

  .emailer-page .em-reader { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .emailer-page .em-reader-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.4rem; color: var(--text-muted); }
  .emailer-page .em-reader-empty p { margin: 0; }
  .emailer-page .em-convo { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .emailer-page .em-convo-head { display: flex; align-items: flex-start; gap: 0.6rem; padding: 0.8rem 1rem; border-bottom: 1px solid var(--border-default); }
  .emailer-page .em-back { display: none; }
  .emailer-page .em-convo-title { flex: 1; min-width: 0; }
  .emailer-page .em-convo-title h3 { margin: 0 0 0.25rem; font-size: 1.02rem; color: var(--text-primary); word-break: break-word; }
  .emailer-page .em-convo-sub { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-size: 0.78rem; color: var(--text-secondary); }
  .emailer-page .em-convo-actions { display: flex; align-items: center; gap: 0.1rem; flex-shrink: 0; }
  .emailer-page .em-mono { font-family: var(--font-mono); font-size: 0.78rem; }
  .emailer-page .em-messages { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.8rem; background: var(--bg-glass); }
  .emailer-page .em-msg { max-width: min(760px, 92%); border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-elevated); padding: 0.75rem 0.9rem; box-shadow: var(--shadow-sm); }
  .emailer-page .em-msg.in { align-self: flex-start; border-top-left-radius: 4px; }
  .emailer-page .em-msg.out { align-self: flex-end; border-top-right-radius: 4px; background: color-mix(in srgb, var(--accent) 9%, var(--bg-elevated)); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
  .emailer-page .em-msg.failed { border-color: var(--danger); }
  .emailer-page .em-msg-head { display: flex; align-items: center; gap: 0.55rem; }
  .emailer-page .em-msg-who { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 0.84rem; color: var(--text-primary); }
  .emailer-page .em-msg-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 0.15rem; flex-shrink: 0; }
  .emailer-page .em-dir { display: inline-flex; align-items: center; gap: 0.2rem; font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .emailer-page .em-dir.in { color: var(--info); }
  .emailer-page .em-dir.out { color: var(--accent-light); }
  .emailer-page .em-msg-body { margin-top: 0.6rem; font-size: 0.88rem; line-height: 1.55; color: var(--text-primary); white-space: pre-wrap; word-break: break-word; }
  .emailer-page .em-quoted-toggle { display: block; margin-top: 0.4rem; border: 1px solid var(--border-default); background: var(--bg-sunken); color: var(--text-muted); border-radius: 6px; font-size: 0.7rem; padding: 0 0.45rem; cursor: pointer; line-height: 1.4; }
  .emailer-page .em-quoted { margin-top: 0.4rem; padding-left: 0.7rem; border-left: 2px solid var(--border-default); color: var(--text-muted); font-size: 0.8rem; }
  .emailer-page .em-msg-modes { display: inline-flex; margin-top: 0.5rem; border: 1px solid var(--border-default); border-radius: var(--radius-sm); overflow: hidden; }
  .emailer-page .em-msg-modes button { display: inline-flex; align-items: center; gap: 0.25rem; border: none; border-radius: 0; background: none; font-size: 0.7rem; padding: 0.15rem 0.5rem; color: var(--text-secondary); cursor: pointer; }
  .emailer-page .em-msg-modes button.active { background: var(--accent-soft); color: var(--accent-light); }
  .emailer-page .em-html { margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.3rem; }
  .emailer-page .em-html iframe { width: 100%; min-height: 320px; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: #fff; resize: vertical; }
  .emailer-page .em-attachments { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.6rem; }
  .emailer-page .em-attachment { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-default); background: var(--bg-sunken); color: var(--text-secondary); }
  .emailer-page .em-msg-foot { margin-top: 0.55rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .emailer-page .em-msg-foot span { display: inline-flex; align-items: center; gap: 0.3rem; flex-wrap: wrap; }
  .emailer-page .em-reply { border-top: 1px solid var(--border-default); padding: 0.7rem 1rem; display: flex; flex-direction: column; gap: 0.4rem; background: var(--bg-card); }
  .emailer-page .em-reply-meta { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .emailer-page .em-reply-box { width: 100%; resize: vertical; min-height: 84px; font-family: inherit; }
  .emailer-page .em-cc { width: 100%; }
  .emailer-page .em-reply-actions { display: flex; justify-content: flex-end; align-items: center; gap: 0.6rem; }
  .emailer-page .em-linkbtn { background: none; border: none; padding: 0; color: var(--accent-light); cursor: pointer; font: inherit; display: inline-flex; align-items: center; gap: 0.25rem; }
  .emailer-page .em-linkbtn:hover { text-decoration: underline; }

  .emailer-page .em-compose { max-width: 640px; width: 100%; }
  .emailer-page .em-form { display: flex; flex-direction: column; gap: 0.8rem; }
  .emailer-page .em-form label { display: flex; flex-direction: column; gap: 0.3rem; }
  .emailer-page .em-form input, .emailer-page .em-form select, .emailer-page .em-form textarea { width: 100%; }
  .emailer-page .em-form textarea { font-family: inherit; resize: vertical; }

  .emailer-page .em-mailboxes { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem; }
  .emailer-page .em-mailbox { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; padding: 0.75rem 0.85rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-sunken); }
  .emailer-page .em-mailbox-main { min-width: 0; flex: 1 1 340px; display: flex; flex-direction: column; gap: 0.35rem; }
  .emailer-page .em-mailbox-facts { display: flex; flex-wrap: wrap; gap: 0.3rem 1rem; font-size: 0.76rem; color: var(--text-secondary); }
  .emailer-page .em-mailbox-facts > span { display: inline-flex; align-items: center; gap: 0.3rem; min-width: 0; max-width: 100%; }
  .emailer-page .em-mailbox-facts .em-mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; display: inline-block; }
  .emailer-page .em-mailbox-actions { display: flex; flex-wrap: wrap; gap: 0.25rem; }

  .emailer-page .em-setup { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 1rem; align-items: start; }
  .emailer-page .em-step { margin: 0; }
  .emailer-page .em-step-head { display: flex; align-items: center; gap: 0.6rem; }
  .emailer-page .em-step-head h3 { margin: 0; font-size: 0.95rem; }
  .emailer-page .em-step-n { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-light); font-size: 0.75rem; font-weight: 700; flex-shrink: 0; }
  .emailer-page .em-step.done .em-step-n { background: var(--success-soft); color: var(--success); }
  .emailer-page .em-step-body { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.6rem; }
  .emailer-page .em-step-body p { margin: 0; }
  .emailer-page .em-kv { display: flex; flex-direction: column; gap: 0.35rem; }
  .emailer-page .em-secret { display: flex; align-items: center; gap: 0.3rem; padding: 0.35rem 0.5rem; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-sunken); min-width: 0; }
  .emailer-page .em-secret code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.76rem; }
  .emailer-page .em-code { margin: 0; padding: 0.7rem; max-height: 280px; overflow: auto; font-size: 0.72rem; line-height: 1.5; background: var(--bg-sunken); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); white-space: pre; font-family: var(--font-mono); }
  .emailer-page .em-details summary { cursor: pointer; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.4rem; }
  .emailer-page .em-details .em-code { margin-bottom: 0.4rem; }
  .emailer-page .spin { animation: em-spin 0.9s linear infinite; }
  @keyframes em-spin { to { transform: rotate(360deg); } }

  @media (max-width: 1100px) {
    .emailer-page .em-shell { grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); }
    .emailer-page .em-rail { display: none; }
  }
  @media (max-width: 760px) {
    .emailer-page .em-shell { grid-template-columns: minmax(0, 1fr); height: auto; min-height: 70vh; }
    .emailer-page .em-shell .em-reader { display: none; }
    .emailer-page .em-shell.has-selection .em-list { display: none; }
    .emailer-page .em-shell.has-selection .em-reader { display: flex; min-height: 70vh; }
    .emailer-page .em-back { display: inline-flex; }
    .emailer-page .em-setup { grid-template-columns: minmax(0, 1fr); }
    .emailer-page .em-msg { max-width: 100%; }
  }
`
      }}
    />
  );
}
