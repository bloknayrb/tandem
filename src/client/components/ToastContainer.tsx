import type { Toast } from "../hooks/useNotifications";

const SEVERITY_COLORS: Record<Toast["severity"], string> = {
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#6366f1",
};

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <>
      <style>{`
        @keyframes tandem-toast-slide-in {
          from {
            opacity: 0;
            transform: translateX(40px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
      `}</style>
      <div
        data-testid="toast-container"
        style={{
          position: "fixed",
          bottom: 40,
          right: 16,
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          maxWidth: 360,
          pointerEvents: "none",
        }}
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
    </>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const borderColor = SEVERITY_COLORS[toast.severity];
  const ariaRole = toast.severity === "info" ? "status" : "alert";

  return (
    <div
      role={ariaRole}
      data-testid={`toast-${toast.id}`}
      style={{
        pointerEvents: "auto",
        background: "var(--tandem-surface)",
        borderRadius: 6,
        borderLeft: `4px solid ${borderColor}`,
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08)",
        padding: "10px 32px 10px 12px",
        position: "relative",
        animation: "tandem-toast-slide-in 0.2s ease-out",
        fontSize: 13,
        lineHeight: 1.4,
        color: "var(--tandem-fg)",
      }}
    >
      <span>{toast.message}</span>
      {toast.count > 1 && (
        <span
          data-testid={`toast-count-${toast.id}`}
          style={{
            marginLeft: 6,
            fontSize: 11,
            fontWeight: 600,
            color: borderColor,
            background: `${borderColor}18`,
            padding: "1px 5px",
            borderRadius: 8,
          }}
        >
          {"\u00d7"}
          {toast.count}
        </span>
      )}
      <button
        data-testid={`toast-dismiss-${toast.id}`}
        onClick={() => onDismiss(toast.id)}
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: 14,
          color: "var(--tandem-fg-subtle)",
          lineHeight: 1,
          padding: "2px 4px",
        }}
        aria-label="Dismiss notification"
      >
        {"\u00d7"}
      </button>
    </div>
  );
}
