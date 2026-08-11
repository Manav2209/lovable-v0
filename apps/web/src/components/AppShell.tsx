import type { ReactNode } from "react";
import { TopBar } from "@/components/Brand";
import {
  ProjectsSidebar,
  useSidebarCollapsed,
} from "@/components/ProjectsSidebar";

export function AppShell({ children }: { children: ReactNode }) {
  const { collapsed, toggle } = useSidebarCollapsed();

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <ProjectsSidebar collapsed={collapsed} onToggle={toggle} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
