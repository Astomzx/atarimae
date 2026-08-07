import type {
  AuthenticatedUser,
  CreateOrgUnitRequest,
  CreateOwnerRequest,
  CreateUserRequest,
  ErrorResponse,
  HealthResponse,
  LoginRequest,
  OrgUnit,
  Role,
  SessionSummary,
  SetupStatusResponse,
  UserSummary,
} from "@atarimae/api-schema";

const BASE = "/api/v1";

/**
 * Carries the server's stable `code` so the UI can branch on it and show a
 * localised message. The server's English `message` is developer-facing and is
 * never rendered to end users.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);

  // Only declare a JSON body when there actually is one. Fastify rejects a
  // request carrying `content-type: application/json` with an empty body, so
  // sending it unconditionally breaks every write with no payload — sign-out,
  // disable, restore, revoke.
  if (init?.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "same-origin",
    headers,
  });

  if (!response.ok) {
    let body: ErrorResponse | undefined;
    try {
      body = (await response.json()) as ErrorResponse;
    } catch {
      // Non-JSON error, e.g. a proxy returning HTML.
    }
    throw new ApiRequestError(
      response.status,
      body?.code ?? "UNKNOWN",
      body?.message ?? response.statusText,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/**
 * Identifies this browser across sign-ins so the server reuses one device row
 * rather than accumulating a new one — and eventually a duplicate push
 * subscription — every time somebody logs in.
 */
const DEVICE_KEY = "atarimae.deviceToken";

export function deviceToken(): string {
  let token = localStorage.getItem(DEVICE_KEY);
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem(DEVICE_KEY, token);
  }
  return token;
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux";
  return "ブラウザ";
}

export const api = {
  health: () => request<HealthResponse>("/health"),

  setup: {
    status: () => request<SetupStatusResponse>("/setup/status"),
    createOwner: (input: CreateOwnerRequest) =>
      send<{ user: AuthenticatedUser }>("POST", "/setup/owner", input),
  },

  auth: {
    me: () => request<AuthenticatedUser>("/auth/me"),
    login: (input: Omit<LoginRequest, "deviceToken" | "deviceName">) =>
      send<{ user: AuthenticatedUser }>("POST", "/auth/login", {
        ...input,
        deviceToken: deviceToken(),
        deviceName: deviceName(),
      }),
    logout: () => send<void>("POST", "/auth/logout"),
    sessions: () => request<{ items: SessionSummary[] }>("/auth/sessions"),
    revokeSession: (id: string) => send<void>("DELETE", `/auth/sessions/${id}`),
  },

  users: {
    list: (params: { orgUnitId?: string; includeDisabled?: boolean } = {}) => {
      const query = new URLSearchParams();
      if (params.orgUnitId) query.set("orgUnitId", params.orgUnitId);
      if (params.includeDisabled) query.set("includeDisabled", "true");
      const suffix = query.toString();
      return request<{ items: UserSummary[] }>(`/users${suffix ? `?${suffix}` : ""}`);
    },
    create: (input: CreateUserRequest) => send<UserSummary>("POST", "/users", input),
    setRole: (id: string, role: Role) =>
      send<UserSummary>("PATCH", `/users/${id}/role`, { role }),
    disable: (id: string) => send<UserSummary>("POST", `/users/${id}/disable`),
    restore: (id: string) => send<UserSummary>("POST", `/users/${id}/restore`),
    assignOrgUnit: (id: string, orgUnitId: string, isPrimary: boolean) =>
      send<UserSummary>("POST", `/users/${id}/org-units`, { orgUnitId, isPrimary }),
    removeOrgUnit: (id: string, orgUnitId: string) =>
      send<void>("DELETE", `/users/${id}/org-units/${orgUnitId}`),
  },

  orgUnits: {
    list: (includeDisabled = false) =>
      request<{ items: OrgUnit[] }>(
        `/org-units${includeDisabled ? "?includeDisabled=true" : ""}`,
      ),
    create: (input: CreateOrgUnitRequest) => send<OrgUnit>("POST", "/org-units", input),
    rename: (id: string, name: string) =>
      send<OrgUnit>("PATCH", `/org-units/${id}`, { name }),
    disable: (id: string) => send<OrgUnit>("POST", `/org-units/${id}/disable`),
    restore: (id: string) => send<OrgUnit>("POST", `/org-units/${id}/restore`),
  },
};

/** Japanese messages for the error codes the UI can actually encounter. */
const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "メールアドレスまたはパスワードが正しくありません。",
  ACCOUNT_DISABLED: "このアカウントは停止されています。管理者にお問い合わせください。",
  EMAIL_TAKEN: "そのメールアドレスは既に登録されています。",
  ALREADY_INITIALIZED: "既に初期設定が完了しています。ログインしてください。",
  OWNER_ROLE_REQUIRED: "オーナー権限が必要です。",
  LAST_OWNER: "オーナーは最低1名必要です。先に別のメンバーをオーナーにしてください。",
  SELF_ACTION_FORBIDDEN: "自分自身に対しては実行できません。",
  ORG_UNIT_NAME_TAKEN: "同じ名前の部署が既に存在します。",
  ORG_UNIT_DISABLED: "停止中の部署にはメンバーを追加できません。",
  ALREADY_ASSIGNED: "このメンバーは既にこの部署に所属しています。",
  VALIDATION_FAILED: "入力内容を確認してください。",
  FORBIDDEN: "この操作を行う権限がありません。",
  UNAUTHENTICATED: "ログインが必要です。",
  NOT_FOUND: "対象が見つかりません。",
  TOO_MANY_REQUESTS: "リクエストが多すぎます。しばらくしてからお試しください。",
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return MESSAGES[error.code] ?? "エラーが発生しました。";
  }
  return "サーバーに接続できません。";
}
