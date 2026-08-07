import type { AuthenticatedUser, Role } from "@atarimae/api-schema";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { api, ApiRequestError } from "./api.js";

const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function hasAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "オーナー",
  admin: "管理者",
  member: "メンバー",
};

/**
 * The signed-in user, or null.
 *
 * A 401 is a normal answer here, not a failure — it simply means nobody is
 * signed in — so it resolves to null instead of throwing. Retrying it would
 * only delay the redirect to the login screen.
 */
export function useSession() {
  const query = useQuery<AuthenticatedUser | null>({
    queryKey: ["session"],
    queryFn: async () => {
      try {
        return await api.auth.me();
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  return {
    user: query.data ?? null,
    isLoading: query.isPending,
    isError: query.isError,
  };
}

export function useSetupStatus() {
  return useQuery({
    queryKey: ["setup-status"],
    queryFn: api.setup.status,
    retry: false,
    staleTime: Infinity,
  });
}

export function RequireAuth({
  children,
  minimum,
}: {
  children: ReactNode;
  minimum?: Role;
}) {
  const { user, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) return <FullPageMessage>読み込み中…</FullPageMessage>;

  if (!user) {
    // Remember where they were headed so sign-in can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (minimum && !hasAtLeast(user.role, minimum)) {
    return (
      <FullPageMessage>
        <h1 className="page__title">権限がありません</h1>
        <p className="muted">
          この画面を表示するには{ROLE_LABEL[minimum]}以上の権限が必要です。
        </p>
      </FullPageMessage>
    );
  }

  return <>{children}</>;
}

export function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <div className="centered">
      <div className="centered__inner">{children}</div>
    </div>
  );
}
