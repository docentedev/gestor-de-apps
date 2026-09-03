import type { ReactNode } from "react";

interface SidebarItemProps {
  active: boolean;
  onClick: () => void;
  title: string;
  icon: ReactNode;
  label: string;
}

const SidebarItem = ({ active, onClick, title, icon, label }: SidebarItemProps) => {
  return (
    <button
      className={`sidebar-item ${active ? "active" : ""}`}
      onClick={onClick}
      title={title}
    >
      {icon}
      <span className="sidebar-label">{label}</span>
    </button>
  );
};

export default SidebarItem;
