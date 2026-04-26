import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { DashboardPage } from "./pages/Dashboard";
import { ServicesPage } from "./pages/Services";
import { ServiceLogsPage } from "./pages/ServiceLogs";
import { DatabasesPage } from "./pages/Databases";
import { DeploymentsPage } from "./pages/Deployments";
import { ProjectsPage } from "./pages/Projects";
import { ProxyPage } from "./pages/Proxy";
import { SettingsPage } from "./pages/Settings";
import { NotificationsPage } from "./pages/Notifications";
import { api } from "./lib/api";
import { connectLogs } from "./lib/ws";

type IconProps = { children: ReactNode };
const Icon = ({ children }: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const icons = {
  dashboard: <Icon><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></Icon>,
  services: <Icon><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></Icon>,
  projects: <Icon><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Icon>,
  databases: <Icon><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></Icon>,
  proxy: <Icon><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" /></Icon>,
  deployments: <Icon><path d="M12 2v20" /><path d="M5 9l7-7 7 7" /><path d="M5 15l7 7 7-7" /></Icon>,
  notifications: <Icon><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></Icon>,
  settings: <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></Icon>,
  sun: <Icon><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></Icon>,
  moon: <Icon><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></Icon>
};

function NotificationBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await api<{ unread: number }>("/notifications?limit=1", { silent: true });
        if (!cancelled) setCount(res.unread);
      } catch {
        /* silent */
      }
    };
    void refresh();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as { type?: string };
      if (typed.type === "notification") void refresh();
    });
    const intv = setInterval(() => void refresh(), 60000);
    return () => {
      cancelled = true;
      ws.close();
      clearInterval(intv);
    };
  }, []);
  if (count === 0) return null;
  return (
    <span
      style={{
        marginLeft: "auto",
        background: "var(--danger)",
        color: "white",
        fontSize: "0.68rem",
        padding: "0.08rem 0.4rem",
        borderRadius: "999px",
        fontWeight: 700
      }}
    >
      {count}
    </span>
  );
}

function ServicesCountBadge() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await api<Array<{ status: string }>>("/services", { silent: true });
        if (!cancelled) setCount(res.filter((s) => s.status === "running").length);
      } catch {
        /* silent */
      }
    };
    void refresh();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const typed = payload as { type?: string };
      if (typed.type === "service_status") void refresh();
    });
    const intv = setInterval(() => void refresh(), 60000);
    return () => {
      cancelled = true;
      ws.close();
      clearInterval(intv);
    };
  }, []);
  if (count == null) return null;
  return (
    <span
      style={{
        marginLeft: "auto",
        background: "var(--accent-soft)",
        color: "var(--text-secondary)",
        fontSize: "0.68rem",
        padding: "0.08rem 0.4rem",
        borderRadius: "999px",
        fontWeight: 600
      }}
    >
      {count}
    </span>
  );
}

export function App() {
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem("survhub_sidebar") === "collapsed");
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("survhub_theme") as "dark" | "light") || "dark");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("survhub_theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("survhub_sidebar", collapsed ? "collapsed" : "expanded");
  }, [collapsed]);

  const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? "nav-link active" : "nav-link");

  return (
    <div className="layout" data-sidebar={collapsed ? "collapsed" : "expanded"}>
      <aside className="sidebar">
        <h1>
          <span style={{ color: "var(--accent)" }}>◈</span>
          <span className="sidebar-label">SURVHub</span>
        </h1>
        <p className="muted">Local hosting control plane</p>
        <button
          className="sidebar-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "»" : "«"}
        </button>
        <nav>
          <NavLink to="/dashboard" className={navClass}>
            {icons.dashboard}<span className="sidebar-label">Dashboard</span>
          </NavLink>
          <NavLink to="/services" className={navClass}>
            {icons.services}<span className="sidebar-label">Services</span>
            {!collapsed && <ServicesCountBadge />}
          </NavLink>
          <NavLink to="/projects" className={navClass}>
            {icons.projects}<span className="sidebar-label">Projects</span>
          </NavLink>
          <NavLink to="/databases" className={navClass}>
            {icons.databases}<span className="sidebar-label">Databases</span>
          </NavLink>
          <NavLink to="/proxy" className={navClass}>
            {icons.proxy}<span className="sidebar-label">Proxy</span>
          </NavLink>
          <NavLink to="/deployments" className={navClass}>
            {icons.deployments}<span className="sidebar-label">Deployments</span>
          </NavLink>
          <NavLink to="/notifications" className={navClass}>
            {icons.notifications}<span className="sidebar-label">Notifications</span>
            {!collapsed && <NotificationBadge />}
          </NavLink>
          <NavLink to="/settings" className={navClass}>
            {icons.settings}<span className="sidebar-label">Settings</span>
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <button
            className="btn-ghost"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title="Toggle theme"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", padding: "0.4rem 0.6rem" }}
          >
            {theme === "dark" ? icons.sun : icons.moon}
            <span className="sidebar-footer-text">{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/services/:id/logs" element={<ServiceLogsPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/databases" element={<DatabasesPage />} />
          <Route path="/proxy" element={<ProxyPage />} />
          <Route path="/deployments" element={<DeploymentsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
