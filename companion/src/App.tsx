import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { TabBar } from "./components/TabBar";
import { Toasts } from "./components/Toasts";
import { useVault } from "./hooks/useVault";
import { ActivityScreen } from "./screens/Activity";
import { HomeScreen } from "./screens/Home";
import { PairScreen } from "./screens/Pair";
import { ServiceDetailScreen } from "./screens/ServiceDetail";
import { ServicesScreen } from "./screens/Services";
import { SettingsScreen } from "./screens/Settings";

/**
 * Until this phone is paired with at least one machine there is nothing to
 * show, so every route collapses onto the pairing screen. That is also what
 * makes an inbound deep link work from a cold start: the link lands on /pair
 * with the code already in the query.
 */
function RequirePairing({ children }: { children: React.ReactNode }) {
  const { active } = useVault();
  const location = useLocation();
  if (!active) return <Navigate to="/pair" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function App() {
  const { active } = useVault();
  return (
    <div className="app">
      <Routes>
        <Route path="/pair" element={<PairScreen />} />
        <Route
          path="/"
          element={
            <RequirePairing>
              <HomeScreen />
            </RequirePairing>
          }
        />
        <Route
          path="/services"
          element={
            <RequirePairing>
              <ServicesScreen />
            </RequirePairing>
          }
        />
        <Route
          path="/services/:serviceId"
          element={
            <RequirePairing>
              <ServiceDetailScreen />
            </RequirePairing>
          }
        />
        <Route
          path="/activity"
          element={
            <RequirePairing>
              <ActivityScreen />
            </RequirePairing>
          }
        />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {active && <TabBar />}
      <Toasts />
    </div>
  );
}
