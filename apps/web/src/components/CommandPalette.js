import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Home,
  Server,
  Database,
  Settings,
  Terminal,
  Activity,
  GitBranch,
  Globe,
  SunMoon
} from "lucide-react";
import { useNavigate } from "react-router-dom";
export function CommandPalette({ theme = "dark", onToggleTheme, recentServices = [] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const commands = [
    {
      id: "dash",
      name: "Go to Dashboard",
      icon: Home,
      category: "Navigation",
      shortcut: "G D",
      action: () => navigate("/dashboard")
    },
    {
      id: "svcs",
      name: "Manage Services",
      icon: Server,
      category: "Navigation",
      shortcut: "G S",
      action: () => navigate("/services")
    },
    {
      id: "proj",
      name: "View Projects",
      icon: Globe,
      category: "Navigation",
      shortcut: "G P",
      action: () => navigate("/projects")
    },
    {
      id: "dbs",
      name: "Persistence & Databases",
      icon: Database,
      category: "Navigation",
      shortcut: "G B",
      action: () => navigate("/databases")
    },
    {
      id: "deps",
      name: "Deployment Pipeline",
      icon: Terminal,
      category: "Navigation",
      shortcut: "G L",
      action: () => navigate("/deployments")
    },
    {
      id: "proxy",
      name: "Edge Routing",
      icon: Activity,
      category: "Infrastructure",
      action: () => navigate("/proxy")
    },
    {
      id: "sets",
      name: "System Settings",
      icon: Settings,
      category: "System",
      shortcut: "S S",
      action: () => navigate("/settings")
    },
    {
      id: "theme",
      name: `Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`,
      icon: SunMoon,
      category: "System",
      shortcut: "T T",
      action: () => onToggleTheme?.()
    },
    {
      id: "gh",
      name: "Connect GitHub",
      icon: GitBranch,
      category: "Integrations",
      action: () => navigate("/settings")
    },
    ...recentServices.map((service) => ({
      id: `service-${service.id}`,
      name: `Open ${service.name}`,
      icon: Server,
      category: `Recent Services • ${service.status}`,
      action: () => navigate("/services")
    }))
  ];
  const filtered = query
    ? commands.filter(
        (c) =>
          c.name.toLowerCase().includes(query.toLowerCase()) ||
          c.category.toLowerCase().includes(query.toLowerCase())
      )
    : commands;
  useEffect(() => {
    const down = (e) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);
  const handleAction = (cmd) => {
    cmd.action();
    setOpen(false);
  };
  return _jsx(AnimatePresence, {
    children:
      open &&
      _jsxs("div", {
        className: "modal-overlay",
        onClick: () => setOpen(false),
        style: { alignItems: "flex-start", paddingTop: "15vh" },
        children: [
          _jsxs(motion.div, {
            className: "command-box",
            onClick: (e) => e.stopPropagation(),
            initial: { opacity: 0, scale: 0.95, y: -20 },
            animate: { opacity: 1, scale: 1, y: 0 },
            exit: { opacity: 0, scale: 0.95, y: -20 },
            children: [
              _jsxs("div", {
                className: "command-input",
                children: [
                  _jsx(Search, { size: 20, className: "text-muted" }),
                  _jsx("input", {
                    autoFocus: true,
                    placeholder: "Search commands, services, or projects...",
                    value: query,
                    onChange: (e) => setQuery(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === "Enter" && filtered[activeIndex]) handleAction(filtered[activeIndex]);
                      if (e.key === "ArrowDown" && filtered.length)
                        setActiveIndex((i) => (i + 1) % filtered.length);
                      if (e.key === "ArrowUp" && filtered.length)
                        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
                    }
                  }),
                  _jsx("button", {
                    className: "command-shortcut command-close",
                    onClick: () => setOpen(false),
                    "aria-label": "Close command palette",
                    "data-tooltip": "Close command palette",
                    "data-tooltip-side": "left",
                    children: "ESC"
                  })
                ]
              }),
              _jsxs("div", {
                className: "command-results",
                children: [
                  filtered.map((cmd, i) =>
                    _jsxs(
                      "div",
                      {
                        className: `command-item ${i === activeIndex ? "active" : ""}`,
                        role: "button",
                        tabIndex: 0,
                        "aria-label": `${cmd.name}, ${cmd.category}`,
                        onMouseEnter: () => setActiveIndex(i),
                        onClick: () => handleAction(cmd),
                        onKeyDown: (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleAction(cmd);
                          }
                        },
                        children: [
                          _jsx(cmd.icon, { size: 18 }),
                          _jsx("span", { children: cmd.name }),
                          _jsxs("span", {
                            className: "muted xsmall",
                            style: { marginLeft: "0.5rem" },
                            children: ["in ", cmd.category]
                          }),
                          cmd.shortcut &&
                            _jsx("span", { className: "command-shortcut", children: cmd.shortcut })
                        ]
                      },
                      cmd.id
                    )
                  ),
                  filtered.length === 0 &&
                    _jsx("div", {
                      className: "muted text-center",
                      style: { padding: "2rem" },
                      children: "No matching commands found."
                    })
                ]
              }),
              _jsx("div", {
                className: "modal-footer",
                style: { padding: "0.75rem 1.5rem", background: "rgba(0,0,0,0.2)" },
                children: _jsx("span", {
                  className: "muted tiny",
                  children: "Tip: Jump quickly with \u2318K"
                })
              })
            ]
          }),
          _jsx("style", {
            dangerouslySetInnerHTML: {
              __html: `
            .xsmall { font-size: 0.7rem; }
            .tiny { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.05em; }
          `
            }
          })
        ]
      })
  });
}
