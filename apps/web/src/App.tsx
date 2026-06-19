import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Server,
  FolderKanban,
  Database,
  KeyRound,
  Activity,
  Globe,
  Terminal,
  Bell,
  Settings,
  Sun,
  Moon,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Command
} from "lucide-react";

import { DashboardPage } from "./pages/Dashboard";
import { ServicesPage } from "./pages/Services";
import { ServiceLogsPage } from "./pages/ServiceLogs";
import { DatabasesPage } from "./pages/Databases";
import { SecretsPage } from "./pages/Secrets";
import { DeploymentsPage } from "./pages/Deployments";
import { ProjectsPage } from "./pages/Projects";
import { ProxyPage } from "./pages/Proxy";
import { DomainsPage } from "./pages/Domains";
import { SettingsPage } from "./pages/Settings";
import { NotificationsPage } from "./pages/Notifications";
import { LoginPage } from "./pages/Login";
import { OnboardingPage } from "./pages/Onboarding";
import { api, clearAuthToken } from "./lib/api";
import { connectLogs } from "./lib/ws";
import { CommandPalette } from "./components/CommandPalette";
import { TerminalDock } from "./components/TerminalDock";
import { DockerBanner } from "./components/DockerBanner";

function NotificationBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const token = localStorage.getItem("survhub_token");
      if (!token) return;
      try {
        const res = await api<{ unread: number }>("/notifications?limit=1", { silent: true });
        if (!cancelled) setCount(res.unread);
      } catch {
        /* silent */
      }
    };
    const token = localStorage.getItem("survhub_token");
    if (token) {
      void refresh();
      const ws = connectLogs((payload) => {
        if (typeof payload === "object" && payload && (payload as any).type === "notification")
          void refresh();
      });
      const intv = setInterval(() => void refresh(), 60000);
      return () => {
        cancelled = true;
        ws.close();
        clearInterval(intv);
      };
    }
  }, []);
  if (count === 0) return null;
  return <span className="nav-badge danger">{count}</span>;
}

function ServicesCountBadge() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const token = localStorage.getItem("survhub_token");
      if (!token) return;
      try {
        const res = await api<Array<{ status: string }>>("/services", { silent: true });
        if (!cancelled) setCount(res.filter((s) => s.status === "running").length);
      } catch {
        /* silent */
      }
    };
    const token = localStorage.getItem("survhub_token");
    if (token) {
      void refresh();
      const ws = connectLogs((payload) => {
        if (typeof payload === "object" && payload && (payload as any).type === "service_status")
          void refresh();
      });
      const intv = setInterval(() => void refresh(), 60000);
      return () => {
        cancelled = true;
        ws.close();
        clearInterval(intv);
      };
    }
  }, []);
  if (count == null) return null;
  return <span className="nav-badge">{count}</span>;
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const token = localStorage.getItem("survhub_token");
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

type SidebarService = { id: string; name: string; status: string };

const routeLabels: Record<string, string> = {
  dashboard: "Dashboard",
  services: "Services",
  projects: "Projects",
  secrets: "Secrets",
  databases: "Databases",
  proxy: "Edge Ingress",
  domains: "SaaS Domains",
  deployments: "Deployments",
  notifications: "Alerts",
  settings: "Settings",
  logs: "Logs"
};

function Breadcrumbs({ pathname }: { pathname: string }) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <nav className="topbar-crumb" aria-label="Breadcrumb">
      <span>LocalSURV</span>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="breadcrumb-part">
          <span className="sep">/</span>
          <span>{routeLabels[part] ?? (index === 1 && parts[0] === "services" ? "Service" : part)}</span>
        </span>
      ))}
    </nav>
  );
}

export function App() {
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem("survhub_sidebar") === "collapsed"
  );
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("survhub_theme") as "dark" | "light") || "dark"
  );
  const [bootstrapped, setBootstrapped] = useState<boolean | null>(null);
  const [recentServices, setRecentServices] = useState<SidebarService[]>([]);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("survhub_theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("survhub_sidebar", collapsed ? "collapsed" : "expanded");
  }, [collapsed]);

  useEffect(() => {
    const onAuthExpired = () => {
      if (location.pathname !== "/login" && location.pathname !== "/onboarding") {
        navigate("/login", { replace: true });
      }
    };
    window.addEventListener("survhub:auth-expired", onAuthExpired);
    return () => window.removeEventListener("survhub:auth-expired", onAuthExpired);
  }, [location.pathname, navigate]);

  useEffect(() => {
    async function checkStatus() {
      try {
        const res = await api<{ bootstrapped: boolean }>("/auth/status", { silent: true });
        setBootstrapped(res.bootstrapped);
        // Never bounce an already-authenticated user back to bootstrap; their
        // session is what matters, even if /auth/status flips during a race.
        const hasToken = Boolean(localStorage.getItem("survhub_token"));
        // Respect an explicit "Log in instead" choice from the onboarding screen
        // so a user who already has an account isn't force-routed to bootstrap.
        const preferLogin = sessionStorage.getItem("survhub_prefer_login") === "1";
        if (!res.bootstrapped && !hasToken && !preferLogin && location.pathname !== "/onboarding") {
          navigate("/onboarding");
        }
      } catch {
        /* silent */
      }
    }
    void checkStatus();
  }, [location.pathname, navigate]);

  useEffect(() => {
    let cancelled = false;
    const refreshServices = async () => {
      const token = localStorage.getItem("survhub_token");
      if (!token) return;
      try {
        const res = await api<SidebarService[]>("/services", { silent: true });
        if (!cancelled) setRecentServices(res.slice(0, 5));
      } catch {
        /* silent */
      }
    };
    void refreshServices();
    const intv = setInterval(() => void refreshServices(), 60000);
    return () => {
      cancelled = true;
      clearInterval(intv);
    };
  }, []);

  const isAuthPage = location.pathname === "/login" || location.pathname === "/onboarding";

  if (isAuthPage) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route
          path="*"
          element={
            <Navigate
              to={
                bootstrapped === false && sessionStorage.getItem("survhub_prefer_login") !== "1"
                  ? "/onboarding"
                  : "/login"
              }
              replace
            />
          }
        />
      </Routes>
    );
  }

  return (
    <div className={`app ${collapsed ? "collapsed" : ""}`} data-sidebar={collapsed ? "collapsed" : "expanded"}>
      <CommandPalette
        theme={theme}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        recentServices={recentServices}
      />

      <aside className="sidebar">
        <header className="sb-head">
          <div className="sb-logo">LS</div>
          {!collapsed && (
            <div className="fcol" style={{ gap: 0, minWidth: 0 }}>
              <span className="sb-name">LocalSURV</span>
              <span className="sb-sub">Control Plane</span>
            </div>
          )}
          <button
            className="sb-toggle"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight size={11} /> : <ChevronLeft size={11} />}
          </button>
        </header>

        <nav className="sb-nav">
          <NavLink
            to="/dashboard"
            aria-label="Dashboard"
            title={collapsed ? "Dashboard" : undefined}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <LayoutDashboard size={16} />
            {!collapsed && <span>Dashboard</span>}
          </NavLink>
          <NavLink
            to="/services"
            aria-label="Services"
            title={collapsed ? "Services" : undefined}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <Server size={16} />
            {!collapsed && <span>Services</span>}
            {!collapsed && <ServicesCountBadge />}
          </NavLink>
          <NavLink
            to="/projects"
            aria-label="Projects"
            title={collapsed ? "Projects" : undefined}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <FolderKanban size={16} />
            {!collapsed && <span>Projects</span>}
          </NavLink>
          <NavLink
            to="/secrets"
            aria-label="Secrets"
            title={collapsed ? "Secrets" : undefined}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <KeyRound size={16} />
            {!collapsed && <span>Secrets</span>}
          </NavLink>
          <NavLink
            to="/databases"
            aria-label="Databases"
            title={collapsed ? "Databases" : undefined}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <Database size={16} />
            {!collapsed && <span>Databases</span>}
          </NavLink>
          <NavLink
            to="/proxy"
            aria-label="Edge Ingress"
            title={collapsed ? "Edge Ingress" : undefined}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <Activity size={16} />
            {!collapsed && <span>Edge Ingress</span>}
          </NavLink>
          <NavLink
            to="/domains"
            aria-label="SaaS Domains"
            title={collapsed ? "SaaS Domains" : undefined}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <Globe size={16} />
            {!collapsed && <span>SaaS Domains</span>}
          </NavLink>
          <NavLink
            to="/deployments"
            aria-label="Deployments"
            title={collapsed ? "Deployments" : undefined}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <Terminal size={16} />
            {!collapsed && <span>Deployments</span>}
          </NavLink>
          <NavLink
            to="/notifications"
            aria-label="Alerts"
            title={collapsed ? "Alerts" : undefined}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <Bell size={16} />
            {!collapsed && <span>Alerts</span>}
            {!collapsed && <NotificationBadge />}
          </NavLink>
          <NavLink
            to="/settings"
            aria-label="Settings"
            title={collapsed ? "Settings" : undefined}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <Settings size={16} />
            {!collapsed && <span>Settings</span>}
          </NavLink>
        </nav>

        <footer className="sb-footer">
          <button
            className="nav-item"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            {!collapsed && <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>}
          </button>
          <button
            className="nav-item"
            onClick={() => {
              clearAuthToken();
              navigate("/login");
            }}
            title="Sign out"
          >
            <LogOut size={16} />
            {!collapsed && <span>Sign Out</span>}
          </button>
        </footer>
      </aside>

      <main className="main">
        <div className="topbar">
          <Breadcrumbs pathname={location.pathname} />
          <div className="topbar-right">
            <button
              type="button"
              className="topbar-command"
              onClick={() => window.dispatchEvent(new Event("survhub:open-command-palette"))}
              aria-label="Open command palette"
            >
              <Command size={13} />
              <span>Command</span>
              <kbd>Cmd K</kbd>
            </button>
          </div>
        </div>
        <div className="content">
          <DockerBanner />
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              <Routes location={location} key={location.pathname}>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route
                  path="/dashboard"
                  element={
                    <ProtectedRoute>
                      <DashboardPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/services"
                  element={
                    <ProtectedRoute>
                      <ServicesPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/services/:id/logs"
                  element={
                    <ProtectedRoute>
                      <ServiceLogsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/projects"
                  element={
                    <ProtectedRoute>
                      <ProjectsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/secrets"
                  element={
                    <ProtectedRoute>
                      <SecretsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/databases"
                  element={
                    <ProtectedRoute>
                      <DatabasesPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/proxy"
                  element={
                    <ProtectedRoute>
                      <ProxyPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/domains"
                  element={
                    <ProtectedRoute>
                      <DomainsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/deployments"
                  element={
                    <ProtectedRoute>
                      <DeploymentsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/notifications"
                  element={
                    <ProtectedRoute>
                      <NotificationsPage />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <ProtectedRoute>
                      <SettingsPage />
                    </ProtectedRoute>
                  }
                />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      <TerminalDock />
    </div>
  );
}
