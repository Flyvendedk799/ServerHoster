import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Server,
  FolderKanban,
  Database,
  Activity,
  Terminal,
  Bell,
  Settings,
  Sun,
  Moon,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Search,
  Command,
  Slash
} from "lucide-react";

import { DashboardPage } from "./pages/Dashboard";
import { ServicesPage } from "./pages/Services";
import { ServiceLogsPage } from "./pages/ServiceLogs";
import { DatabasesPage } from "./pages/Databases";
import { DeploymentsPage } from "./pages/Deployments";
import { ProjectsPage } from "./pages/Projects";
import { ProxyPage } from "./pages/Proxy";
import { SettingsPage } from "./pages/Settings";
import { NotificationsPage } from "./pages/Notifications";
import { LoginPage } from "./pages/Login";
import { OnboardingPage } from "./pages/Onboarding";
import { api, clearAuthToken } from "./lib/api";
import { connectLogs } from "./lib/ws";
import { CommandPalette } from "./components/CommandPalette";

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
      } catch { /* silent */ }
    };
    const token = localStorage.getItem("survhub_token");
    if (token) {
      void refresh();
      const ws = connectLogs((payload) => {
        if (typeof payload === "object" && payload && (payload as any).type === "notification") void refresh();
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
  return <span className="badge danger">{count}</span>;
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
      } catch { /* silent */ }
    };
    const token = localStorage.getItem("survhub_token");
    if (token) {
      void refresh();
      const ws = connectLogs((payload) => {
        if (typeof payload === "object" && payload && (payload as any).type === "service_status") void refresh();
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
  return <span className="badge accent">{count}</span>;
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
  databases: "Databases",
  proxy: "Edge Ingress",
  deployments: "Deployments",
  notifications: "Alerts",
  settings: "Settings",
  logs: "Logs"
};

function Breadcrumbs({ pathname }: { pathname: string }) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <span>LocalSURV</span>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="breadcrumb-part">
          <Slash size={12} />
          <span>{routeLabels[part] ?? (index === 1 && parts[0] === "services" ? "Service" : part)}</span>
        </span>
      ))}
    </nav>
  );
}

export function App() {
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem("survhub_sidebar") === "collapsed");
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("survhub_theme") as "dark" | "light") || "dark");
  const [bootstrapped, setBootstrapped] = useState<boolean | null>(null);
  const [sidebarSearch, setSidebarSearch] = useState("");
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
    async function checkStatus() {
      try {
        const res = await api<{ bootstrapped: boolean }>("/auth/status", { silent: true });
        setBootstrapped(res.bootstrapped);
        if (!res.bootstrapped && location.pathname !== "/onboarding") {
          navigate("/onboarding");
        }
      } catch { /* silent */ }
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
      } catch { /* silent */ }
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
        <Route path="*" element={<Navigate to={bootstrapped === false ? "/onboarding" : "/login"} replace />} />
      </Routes>
    );
  }

  return (
    <div className="layout" data-sidebar={collapsed ? "collapsed" : "expanded"}>
      <CommandPalette theme={theme} onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")} recentServices={recentServices} />

      <aside className="sidebar">
        <header className="sidebar-header">
          <h1>
            <span className="logo-icon">◈</span>
            <span className="sidebar-label">LocalSURV</span>
          </h1>
          <p className="muted">Control Plane</p>
        </header>

        <button
          className="sidebar-toggle"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-tooltip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-tooltip-side="right"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>

        {!collapsed && (
          <div className="sidebar-search">
            <Search size={15} />
            <input
              value={sidebarSearch}
              onChange={(event) => setSidebarSearch(event.target.value)}
              placeholder="Quick search..."
            />
            <kbd><Command size={11} />K</kbd>
          </div>
        )}

        <nav>
          <NavLink to="/dashboard" aria-label="Dashboard" data-tooltip={collapsed ? "Dashboard" : undefined} data-tooltip-side="right" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            <LayoutDashboard size={20} /><span className="sidebar-label">Dashboard</span>
          </NavLink>
          <NavLink to="/services" aria-label="Services" data-tooltip={collapsed ? "Services" : undefined} data-tooltip-side="right" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            <Server size={20} /><span className="sidebar-label">Services</span>
            {!collapsed && <ServicesCountBadge />}
          </NavLink>
          <NavLink to="/projects" aria-label="Projects" data-tooltip={collapsed ? "Projects" : undefined} data-tooltip-side="right" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            <FolderKanban size={20} /><span className="sidebar-label">Projects</span>
          </NavLink>
          <NavLink to="/databases" aria-label="Databases" data-tooltip={collapsed ? "Databases" : undefined} data-tooltip-side="right" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            <Database size={20} /><span className="sidebar-label">Databases</span>
          </NavLink>
          <NavLink to="/proxy" aria-label="Edge Ingress" data-tooltip={collapsed ? "Edge Ingress" : undefined} data-tooltip-side="right" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            <Activity size={20} /><span className="sidebar-label">Edge Ingress</span>
          </NavLink>
          <NavLink to="/deployments" aria-label="Deployments" data-tooltip={collapsed ? "Deployments" : undefined} data-tooltip-side="right" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            <Terminal size={20} /><span className="sidebar-label">Deployments</span>
          </NavLink>
          <NavLink to="/notifications" aria-label="Alerts" data-tooltip={collapsed ? "Alerts" : undefined} data-tooltip-side="right" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            <Bell size={20} /><span className="sidebar-label">Alerts</span>
            {!collapsed && <NotificationBadge />}
          </NavLink>
          <NavLink to="/settings" aria-label="Settings" data-tooltip={collapsed ? "Settings" : undefined} data-tooltip-side="right" className={({ isActive }) => isActive ? "nav-link active" : "nav-link"}>
            <Settings size={20} /><span className="sidebar-label">Settings</span>
          </NavLink>
        </nav>

        {!collapsed && recentServices.length > 0 && (
          <section className="sidebar-recents">
            <div className="sidebar-section-label">Recent Services</div>
            {recentServices
              .filter((service) => service.name.toLowerCase().includes(sidebarSearch.toLowerCase()))
              .map((service) => (
                <button
                  key={service.id}
                  className="recent-service"
                  onClick={() => navigate("/services")}
                  aria-label={`Open ${service.name} in services`}
                  data-tooltip={`Open ${service.name}`}
                  data-tooltip-side="right"
                >
                  <span className={`status-dot ${service.status}`} />
                  <span>{service.name}</span>
                  <span className="recent-status">{service.status}</span>
                </button>
              ))}
          </section>
        )}

        <footer className="sidebar-footer">
          <button
            className="ghost"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            data-tooltip={collapsed ? `Switch to ${theme === "dark" ? "light" : "dark"} mode` : undefined}
            data-tooltip-side="right"
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            <span className="sidebar-footer-text">{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
          </button>
          <button
            className="ghost logout"
            onClick={() => { clearAuthToken(); navigate("/login"); }}
            aria-label="Sign out"
            data-tooltip={collapsed ? "Sign out" : undefined}
            data-tooltip-side="right"
          >
            <LogOut size={18} />
            <span className="sidebar-footer-text">Sign Out</span>
          </button>
        </footer>
      </aside>

      <main className="content">
        <Breadcrumbs pathname={location.pathname} />
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
          >
            <Routes location={location} key={location.pathname}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
              <Route path="/services" element={<ProtectedRoute><ServicesPage /></ProtectedRoute>} />
              <Route path="/services/:id/logs" element={<ProtectedRoute><ServiceLogsPage /></ProtectedRoute>} />
              <Route path="/projects" element={<ProtectedRoute><ProjectsPage /></ProtectedRoute>} />
              <Route path="/databases" element={<ProtectedRoute><DatabasesPage /></ProtectedRoute>} />
              <Route path="/proxy" element={<ProtectedRoute><ProxyPage /></ProtectedRoute>} />
              <Route path="/deployments" element={<ProtectedRoute><DeploymentsPage /></ProtectedRoute>} />
              <Route path="/notifications" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
