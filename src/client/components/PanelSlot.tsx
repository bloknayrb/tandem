import type { ComponentProps } from "react";
import { ChatPanel } from "../panels/ChatPanel";
import { SidePanel } from "../panels/SidePanel";

/**
 * Optional visibility wrapper shared by tabbed-layout panel slots.
 *
 * When `visible` is provided the slot wraps its child in a CSS display-flex/none
 * div so the panel stays mounted (preserving local state) while toggling
 * visibility. When `visible` is omitted the panel renders bare (three-panel
 * layout, where both panels are always visible).
 */

interface SlotWrapperProps {
  visible?: boolean;
  children: React.ReactNode;
}

function SlotWrapper({ visible, children }: SlotWrapperProps) {
  if (visible === undefined) return <>{children}</>;
  return (
    <div
      style={{
        display: visible ? "flex" : "none",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      {children}
    </div>
  );
}

type ChatSlotProps = ComponentProps<typeof ChatPanel> & { visible?: boolean };
type SideSlotProps = ComponentProps<typeof SidePanel> & { visible?: boolean };

/** Drop-in wrapper for ChatPanel that handles the display-toggle div in tabbed layout. */
export function ChatSlot({ visible, ...props }: ChatSlotProps) {
  return (
    <SlotWrapper visible={visible}>
      <ChatPanel {...props} />
    </SlotWrapper>
  );
}

/** Drop-in wrapper for SidePanel that handles the display-toggle div in tabbed layout. */
export function SideSlot({ visible, ...props }: SideSlotProps) {
  return (
    <SlotWrapper visible={visible}>
      <SidePanel {...props} />
    </SlotWrapper>
  );
}
