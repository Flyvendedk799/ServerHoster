import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/", label: "Home", icon: "M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" },
  {
    to: "/services",
    label: "Services",
    icon: "M4 4h16v6H4zM4 14h16v6H4zM7.5 7h.01M7.5 17h.01"
  },
  {
    to: "/activity",
    label: "Activity",
    icon: "M3 12h4l3 8 4-16 3 8h4"
  },
  {
    to: "/settings",
    label: "Servers",
    icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.5 1z"
  }
];

/**
 * Bottom navigation, because this is a phone: the top of a 6.7" screen is out
 * of thumb reach, and the OS puts its own gestures at the very bottom — hence
 * the safe-area padding in styles.css rather than a flush-bottom bar.
 */
export function TabBar() {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === "/"}
          className={({ isActive }) => (isActive ? "tab active" : "tab")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" strokeWidth="1.7">
            <path d={tab.icon} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
