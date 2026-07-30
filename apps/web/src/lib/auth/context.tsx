"use client";

import { createContext, useContext } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@agentfactory/core";
import { apiFetch } from "@/lib/api-client";

interface AuthValue {
  user: User;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

// The user is resolved server-side in (app)/layout.tsx (which already redirects to /login when
// there's none), so this just hands that value down — no client-side fetch/loading state needed.
export function AuthProvider({ user, children }: { user: User; children: React.ReactNode }) {
  const router = useRouter();

  const logout = async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  return <AuthContext.Provider value={{ user, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
