import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
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
        const res = await api("/notifications?limit=1", { silent: true });
        if (!cancelled) setCount(res.unread);
      } catch {
        /* silent */
      }
    };
    const token = localStorage.getItem("survhub_token");
    if (token) {
      void refresh();
      const ws = connectLogs((payload) => {
        if (typeof payload === "object" && payload && payload.type === "notification") void refresh();
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
  return _jsx("span", { className: "badge danger", children: count });
}
function ServicesCountBadge() {
  const [count, setCount] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const token = localStorage.getItem("survhub_token");
      if (!token) return;
      try {
        const res = await api("/services", { silent: true });
        if (!cancelled) setCount(res.filter((s) => s.status === "running").length);
      } catch {
        /* silent */
      }
    };
    const token = localStorage.getItem("survhub_token");
    if (token) {
      void refresh();
      const ws = connectLogs((payload) => {
        if (typeof payload === "object" && payload && payload.type === "service_status") void refresh();
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
  return _jsx("span", { className: "badge accent", children: count });
}
function ProtectedRoute({ children }) {
  const token = localStorage.getItem("survhub_token");
  if (!token) return _jsx(Navigate, { to: "/login", replace: true });
  return _jsx(_Fragment, { children: children });
}
const routeLabels = {
  dashboard: "Dashboard",
  services: "Apps",
  projects: "Projects",
  databases: "Databases",
  proxy: "Edge Ingress",
  deployments: "Deployments",
  notifications: "Alerts",
  settings: "Settings",
  logs: "Logs"
};
function Breadcrumbs({ pathname }) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return _jsxs("nav", {
    className: "breadcrumbs",
    "aria-label": "Breadcrumb",
    children: [
      _jsx("span", { children: "LocalSURV" }),
      parts.map((part, index) =>
        _jsxs(
          "span",
          {
            className: "breadcrumb-part",
            children: [
              _jsx(Slash, { size: 12 }),
              _jsx("span", {
                children: routeLabels[part] ?? (index === 1 && parts[0] === "services" ? "Service" : part)
              })
            ]
          },
          `${part}-${index}`
        )
      )
    ]
  });
}
export function App() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("survhub_sidebar") === "collapsed");
  const [theme, setTheme] = useState(() => localStorage.getItem("survhub_theme") || "dark");
  const [bootstrapped, setBootstrapped] = useState(null);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [recentServices, setRecentServices] = useState([]);
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
        const res = await api("/auth/status", { silent: true });
        setBootstrapped(res.bootstrapped);
        // Never bounce an already-authenticated user back to bootstrap; their
        // session is what matters, even if /auth/status flips during a race.
        const hasToken = Boolean(localStorage.getItem("survhub_token"));
        if (!res.bootstrapped && !hasToken && location.pathname !== "/onboarding") {
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
        const res = await api("/services", { silent: true });
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
    return _jsxs(Routes, {
      children: [
        _jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }),
        _jsx(Route, { path: "/onboarding", element: _jsx(OnboardingPage, {}) }),
        _jsx(Route, {
          path: "*",
          element: _jsx(Navigate, { to: bootstrapped === false ? "/onboarding" : "/login", replace: true })
        })
      ]
    });
  }
  return _jsxs("div", {
    className: "layout",
    "data-sidebar": collapsed ? "collapsed" : "expanded",
    children: [
      _jsx(CommandPalette, {
        theme: theme,
        onToggleTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
        recentServices: recentServices
      }),
      _jsxs("aside", {
        className: "sidebar",
        children: [
          _jsxs("header", {
            className: "sidebar-header",
            children: [
              _jsxs("h1", {
                children: [
                  _jsx("span", { className: "logo-icon", children: "\u25C8" }),
                  _jsx("span", { className: "sidebar-label", children: "LocalSURV" })
                ]
              }),
              _jsx("p", { className: "muted", children: "Control Plane" })
            ]
          }),
          _jsx("button", {
            className: "sidebar-toggle",
            onClick: () => setCollapsed(!collapsed),
            "aria-label": collapsed ? "Expand sidebar" : "Collapse sidebar",
            "data-tooltip": collapsed ? "Expand sidebar" : "Collapse sidebar",
            "data-tooltip-side": "right",
            children: collapsed ? _jsx(ChevronRight, { size: 14 }) : _jsx(ChevronLeft, { size: 14 })
          }),
          !collapsed &&
            _jsxs("div", {
              className: "sidebar-search",
              children: [
                _jsx(Search, { size: 15 }),
                _jsx("input", {
                  value: sidebarSearch,
                  onChange: (event) => setSidebarSearch(event.target.value),
                  placeholder: "Quick search..."
                }),
                _jsxs("kbd", { children: [_jsx(Command, { size: 11 }), "K"] })
              ]
            }),
          _jsxs("nav", {
            children: [
              _jsxs(NavLink, {
                to: "/dashboard",
                "aria-label": "Dashboard",
                "data-tooltip": collapsed ? "Dashboard" : undefined,
                "data-tooltip-side": "right",
                className: ({ isActive }) => (isActive ? "nav-link active" : "nav-link"),
                children: [
                  _jsx(LayoutDashboard, { size: 20 }),
                  _jsx("span", { className: "sidebar-label", children: "Dashboard" })
                ]
              }),
              _jsxs(NavLink, {
                to: "/services",
                "aria-label": "Apps",
                "data-tooltip": collapsed ? "Apps" : undefined,
                "data-tooltip-side": "right",
                className: ({ isActive }) => (isActive ? "nav-link active" : "nav-link"),
                children: [
                  _jsx(Server, { size: 20 }),
                  _jsx("span", { className: "sidebar-label", children: "Apps" }),
                  !collapsed && _jsx(ServicesCountBadge, {})
                ]
              }),
              _jsxs(NavLink, {
                to: "/projects",
                "aria-label": "Projects",
                "data-tooltip": collapsed ? "Projects" : undefined,
                "data-tooltip-side": "right",
                className: ({ isActive }) => (isActive ? "nav-link active" : "nav-link"),
                children: [
                  _jsx(FolderKanban, { size: 20 }),
                  _jsx("span", { className: "sidebar-label", children: "Projects" })
                ]
              }),
              _jsxs(NavLink, {
                to: "/databases",
                "aria-label": "Databases",
                "data-tooltip": collapsed ? "Databases" : undefined,
                "data-tooltip-side": "right",
                className: ({ isActive }) => (isActive ? "nav-link active" : "nav-link"),
                children: [
                  _jsx(Database, { size: 20 }),
                  _jsx("span", { className: "sidebar-label", children: "Databases" })
                ]
              }),
              _jsxs(NavLink, {
                to: "/proxy",
                "aria-label": "Edge Ingress",
                "data-tooltip": collapsed ? "Edge Ingress" : undefined,
                "data-tooltip-side": "right",
                className: ({ isActive }) => (isActive ? "nav-link active" : "nav-link"),
                children: [
                  _jsx(Activity, { size: 20 }),
                  _jsx("span", { className: "sidebar-label", children: "Edge Ingress" })
                ]
              }),
              _jsxs(NavLink, {
                to: "/deployments",
                "aria-label": "Deployments",
                "data-tooltip": collapsed ? "Deployments" : undefined,
                "data-tooltip-side": "right",
                className: ({ isActive }) => (isActive ? "nav-link active" : "nav-link"),
                children: [
                  _jsx(Terminal, { size: 20 }),
                  _jsx("span", { className: "sidebar-label", children: "Deployments" })
                ]
              }),
              _jsxs(NavLink, {
                to: "/notifications",
                "aria-label": "Alerts",
                "data-tooltip": collapsed ? "Alerts" : undefined,
                "data-tooltip-side": "right",
                className: ({ isActive }) => (isActive ? "nav-link active" : "nav-link"),
                children: [
                  _jsx(Bell, { size: 20 }),
                  _jsx("span", { className: "sidebar-label", children: "Alerts" }),
                  !collapsed && _jsx(NotificationBadge, {})
                ]
              }),
              _jsxs(NavLink, {
                to: "/settings",
                "aria-label": "Settings",
                "data-tooltip": collapsed ? "Settings" : undefined,
                "data-tooltip-side": "right",
                className: ({ isActive }) => (isActive ? "nav-link active" : "nav-link"),
                children: [
                  _jsx(Settings, { size: 20 }),
                  _jsx("span", { className: "sidebar-label", children: "Settings" })
                ]
              })
            ]
          }),
          !collapsed &&
            recentServices.length > 0 &&
            _jsxs("section", {
              className: "sidebar-recents",
              children: [
                _jsx("div", { className: "sidebar-section-label", children: "Recent Services" }),
                recentServices
                  .filter((service) => service.name.toLowerCase().includes(sidebarSearch.toLowerCase()))
                  .map((service) =>
                    _jsxs(
                      "button",
                      {
                        className: "recent-service",
                        onClick: () => navigate("/services"),
                        "aria-label": `Open ${service.name} in services`,
                        "data-tooltip": `Open ${service.name}`,
                        "data-tooltip-side": "right",
                        children: [
                          _jsx("span", { className: `status-dot ${service.status}` }),
                          _jsx("span", { children: service.name }),
                          _jsx("span", { className: "recent-status", children: service.status })
                        ]
                      },
                      service.id
                    )
                  )
              ]
            }),
          _jsxs("footer", {
            className: "sidebar-footer",
            children: [
              _jsxs("button", {
                className: "ghost",
                onClick: () => setTheme(theme === "dark" ? "light" : "dark"),
                "aria-label": `Switch to ${theme === "dark" ? "light" : "dark"} mode`,
                "data-tooltip": collapsed
                  ? `Switch to ${theme === "dark" ? "light" : "dark"} mode`
                  : undefined,
                "data-tooltip-side": "right",
                children: [
                  theme === "dark" ? _jsx(Sun, { size: 18 }) : _jsx(Moon, { size: 18 }),
                  _jsx("span", {
                    className: "sidebar-footer-text",
                    children: theme === "dark" ? "Light Mode" : "Dark Mode"
                  })
                ]
              }),
              _jsxs("button", {
                className: "ghost logout",
                onClick: () => {
                  clearAuthToken();
                  navigate("/login");
                },
                "aria-label": "Sign out",
                "data-tooltip": collapsed ? "Sign out" : undefined,
                "data-tooltip-side": "right",
                children: [
                  _jsx(LogOut, { size: 18 }),
                  _jsx("span", { className: "sidebar-footer-text", children: "Sign Out" })
                ]
              })
            ]
          })
        ]
      }),
      _jsxs("main", {
        className: "content",
        children: [
          _jsx(Breadcrumbs, { pathname: location.pathname }),
          _jsx(AnimatePresence, {
            mode: "wait",
            children: _jsx(
              motion.div,
              {
                initial: { opacity: 0, y: 10, filter: "blur(4px)" },
                animate: { opacity: 1, y: 0, filter: "blur(0px)" },
                exit: { opacity: 0, y: -10, filter: "blur(4px)" },
                transition: { duration: 0.25, ease: "easeInOut" },
                children: _jsxs(
                  Routes,
                  {
                    location: location,
                    children: [
                      _jsx(Route, {
                        path: "/",
                        element: _jsx(Navigate, { to: "/dashboard", replace: true })
                      }),
                      _jsx(Route, {
                        path: "/dashboard",
                        element: _jsx(ProtectedRoute, { children: _jsx(DashboardPage, {}) })
                      }),
                      _jsx(Route, {
                        path: "/services",
                        element: _jsx(ProtectedRoute, { children: _jsx(ServicesPage, {}) })
                      }),
                      _jsx(Route, {
                        path: "/services/:id/logs",
                        element: _jsx(ProtectedRoute, { children: _jsx(ServiceLogsPage, {}) })
                      }),
                      _jsx(Route, {
                        path: "/projects",
                        element: _jsx(ProtectedRoute, { children: _jsx(ProjectsPage, {}) })
                      }),
                      _jsx(Route, {
                        path: "/databases",
                        element: _jsx(ProtectedRoute, { children: _jsx(DatabasesPage, {}) })
                      }),
                      _jsx(Route, {
                        path: "/proxy",
                        element: _jsx(ProtectedRoute, { children: _jsx(ProxyPage, {}) })
                      }),
                      _jsx(Route, {
                        path: "/deployments",
                        element: _jsx(ProtectedRoute, { children: _jsx(DeploymentsPage, {}) })
                      }),
                      _jsx(Route, {
                        path: "/notifications",
                        element: _jsx(ProtectedRoute, { children: _jsx(NotificationsPage, {}) })
                      }),
                      _jsx(Route, {
                        path: "/settings",
                        element: _jsx(ProtectedRoute, { children: _jsx(SettingsPage, {}) })
                      }),
                      _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/dashboard", replace: true }) })
                    ]
                  },
                  location.pathname
                )
              },
              location.pathname
            )
          })
        ]
      })
    ]
  });
}
