import { motion } from "framer-motion";

export function Skeleton({ className = "", style = {} }) {
  return (
    <motion.div
      className={`skeleton ${className}`}
      style={style}
      initial={{ opacity: 0.5 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.8, repeat: Infinity, repeatType: "reverse" }}
    />
  );
}

export function CardSkeleton() {
  return (
    <div className="card" style={{ pointerEvents: "none" }}>
      <Skeleton style={{ height: "1.5rem", width: "60%", marginBottom: "1rem" }} />
      <Skeleton style={{ height: "4rem", width: "100%", marginBottom: "1.5rem" }} />
      <div className="row">
         <Skeleton style={{ height: "2rem", width: "80px", borderRadius: "var(--radius-full)" }} />
         <Skeleton style={{ height: "2rem", width: "120px", borderRadius: "var(--radius-md)" }} />
      </div>
    </div>
  );
}
