import { Link, Navigate, Route, Routes } from "react-router-dom";
import { DashboardPage } from "./pages/Dashboard";
import { ServicesPage } from "./pages/Services";
import { DatabasesPage } from "./pages/Databases";
import { DeploymentsPage } from "./pages/Deployments";
import { ProjectsPage } from "./pages/Projects";
import { ProxyPage } from "./pages/Proxy";
import { SettingsPage } from "./pages/Settings";

export function App() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>SURVHub</h1>
        <nav>
          <Link to="/dashboard">Dashboard</Link>
          <Link to="/services">Services</Link>
          <Link to="/projects">Projects</Link>
          <Link to="/databases">Databases</Link>
          <Link to="/proxy">Proxy</Link>
          <Link to="/deployments">Deployments</Link>
          <Link to="/settings">Settings</Link>
        </nav>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/databases" element={<DatabasesPage />} />
          <Route path="/proxy" element={<ProxyPage />} />
          <Route path="/deployments" element={<DeploymentsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
