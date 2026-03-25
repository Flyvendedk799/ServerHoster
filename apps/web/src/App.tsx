import { NavLink, Navigate, Route, Routes } from "react-router-dom";
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
        <p className="muted">Local hosting control plane</p>
        <nav>
          <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>Dashboard</NavLink>
          <NavLink to="/services" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>Services</NavLink>
          <NavLink to="/projects" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>Projects</NavLink>
          <NavLink to="/databases" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>Databases</NavLink>
          <NavLink to="/proxy" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>Proxy</NavLink>
          <NavLink to="/deployments" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>Deployments</NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>Settings</NavLink>
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
