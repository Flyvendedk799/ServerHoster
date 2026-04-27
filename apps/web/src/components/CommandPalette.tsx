import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Home, Server, Database, Settings, Terminal, Activity, GitBranch, Globe, SunMoon } from "lucide-react";
import { useNavigate } from "react-router-dom";

type Command = {
  id: string;
  name: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  category: string;
  shortcut?: string;
  action: () => void;
};

type Props = {
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  recentServices?: Array<{ id: string; name: string; status: string }>;
};

export function CommandPalette({ theme = "dark", onToggleTheme, recentServices = [] }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();

  const commands: Command[] = [
    { id: "dash", name: "Go to Dashboard", icon: Home, category: "Navigation", shortcut: "G D", action: () => navigate("/dashboard") },
    { id: "svcs", name: "Manage Services", icon: Server, category: "Navigation", shortcut: "G S", action: () => navigate("/services") },
    { id: "proj", name: "View Projects", icon: Globe, category: "Navigation", shortcut: "G P", action: () => navigate("/projects") },
    { id: "dbs", name: "Persistence & Databases", icon: Database, category: "Navigation", shortcut: "G B", action: () => navigate("/databases") },
    { id: "deps", name: "Deployment Pipeline", icon: Terminal, category: "Navigation", shortcut: "G L", action: () => navigate("/deployments") },
    { id: "proxy", name: "Edge Routing", icon: Activity, category: "Infrastructure", action: () => navigate("/proxy") },
    { id: "sets", name: "System Settings", icon: Settings, category: "System", shortcut: "S S", action: () => navigate("/settings") },
    { id: "theme", name: `Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`, icon: SunMoon, category: "System", shortcut: "T T", action: () => onToggleTheme?.() },
    { id: "gh", name: "Connect GitHub", icon: GitBranch, category: "Integrations", action: () => navigate("/settings") },
    ...recentServices.map((service) => ({
      id: `service-${service.id}`,
      name: `Open ${service.name}`,
      icon: Server,
      category: `Recent Services • ${service.status}`,
      action: () => navigate("/services")
    }))
  ];

  const filtered = query 
    ? commands.filter(c => c.name.toLowerCase().includes(query.toLowerCase()) || c.category.toLowerCase().includes(query.toLowerCase()))
    : commands;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
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

  const handleAction = (cmd: Command) => {
    cmd.action();
    setOpen(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)} style={{ alignItems: "flex-start", paddingTop: "15vh" }}>
          <motion.div 
            className="command-box"
            onClick={e => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
          >
            <div className="command-input">
              <Search size={20} className="text-muted" />
              <input 
                autoFocus
                placeholder="Search commands, services, or projects..." 
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filtered[activeIndex]) handleAction(filtered[activeIndex]);
                  if (e.key === "ArrowDown" && filtered.length) setActiveIndex(i => (i + 1) % filtered.length);
                  if (e.key === "ArrowUp" && filtered.length) setActiveIndex(i => (i - 1 + filtered.length) % filtered.length);
                }}
              />
              <button
                className="command-shortcut command-close"
                onClick={() => setOpen(false)}
                aria-label="Close command palette"
                data-tooltip="Close command palette"
                data-tooltip-side="left"
              >
                ESC
              </button>
            </div>

            <div className="command-results">
              {filtered.map((cmd, i) => (
                <div 
                  key={cmd.id} 
                  className={`command-item ${i === activeIndex ? "active" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${cmd.name}, ${cmd.category}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => handleAction(cmd)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleAction(cmd);
                    }
                  }}
                >
                  <cmd.icon size={18} />
                  <span>{cmd.name}</span>
                  <span className="muted xsmall" style={{ marginLeft: "0.5rem" }}>in {cmd.category}</span>
                  {cmd.shortcut && <span className="command-shortcut">{cmd.shortcut}</span>}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="muted text-center" style={{ padding: "2rem" }}>
                   No matching commands found.
                </div>
              )}
            </div>
            
            <div className="modal-footer" style={{ padding: "0.75rem 1.5rem", background: "rgba(0,0,0,0.2)" }}>
               <span className="muted tiny">Tip: Jump quickly with ⌘K</span>
            </div>
          </motion.div>

          <style dangerouslySetInnerHTML={{ __html: `
            .xsmall { font-size: 0.7rem; }
            .tiny { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.05em; }
          `}} />
        </div>
      )}
    </AnimatePresence>
  );
}
