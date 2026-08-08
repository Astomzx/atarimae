import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { api } from "../api.js";

/**
 * Everybody's name, by id.
 *
 * Mentions are stored as ids, so turning one back into a name needs a
 * directory. The channel's own member list is not enough: somebody who has
 * since left the channel is still named in its history, and a message that
 * reads "@不明なメンバー" where a colleague's name belongs is the interface
 * losing track of a person who is standing right there.
 *
 * The same query key as the members screen, so this shares one fetch with it
 * rather than adding a second.
 */
export function useDirectory(): ReadonlyMap<string, string> {
  const users = useQuery({
    queryKey: ["users", {}],
    queryFn: () => api.users.list(),
    staleTime: 60_000,
  });

  return useMemo(
    () => new Map((users.data?.items ?? []).map((user) => [user.id, user.displayName])),
    [users.data],
  );
}
