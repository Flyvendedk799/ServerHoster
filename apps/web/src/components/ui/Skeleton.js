import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from "framer-motion";
export function Skeleton({ className = "", style = {} }) {
  return _jsx(motion.div, {
    className: `skeleton ${className}`,
    style: style,
    initial: { opacity: 0.5 },
    animate: { opacity: 1 },
    transition: { duration: 0.8, repeat: Infinity, repeatType: "reverse" }
  });
}
export function CardSkeleton() {
  return _jsxs("div", {
    className: "card",
    style: { pointerEvents: "none" },
    children: [
      _jsx(Skeleton, { style: { height: "1.5rem", width: "60%", marginBottom: "1rem" } }),
      _jsx(Skeleton, { style: { height: "4rem", width: "100%", marginBottom: "1.5rem" } }),
      _jsxs("div", {
        className: "row",
        children: [
          _jsx(Skeleton, { style: { height: "2rem", width: "80px", borderRadius: "var(--radius-full)" } }),
          _jsx(Skeleton, { style: { height: "2rem", width: "120px", borderRadius: "var(--radius-md)" } })
        ]
      })
    ]
  });
}
