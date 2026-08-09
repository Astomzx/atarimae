import type {
  AcknowledgementStatistics,
  AnnouncementDetail,
  AnnouncementSummary,
  AnnouncementTarget,
  AuthenticatedUser,
  CommandSummary,
  CreateAnnouncementRequest,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  CreateChannelRequest,
  CreateServiceAccountRequest,
  CreateWebhookRequest,
  CreateWebhookResponse,
  CreateOrgUnitRequest,
  CreateOwnerRequest,
  CreateUserRequest,
  ErrorResponse,
  HealthResponse,
  ListApiTokensResponse,
  ListChannelMembersResponse,
  ListChannelsResponse,
  ListMessagesResponse,
  ListServiceAccountsResponse,
  ListWebhookDeliveriesResponse,
  ListWebhooksResponse,
  LoginRequest,
  Message,
  MyAnnouncement,
  OrgUnit,
  PublishResponse,
  ReviseContentRequest,
  Role,
  SendMessageRequest,
  ServiceAccount,
  SessionSummary,
  SetupStatusResponse,
  SmtpSettingsResponse,
  UploadAttachmentResponse,
  UserSummary,
  Webhook,
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

/**
 * A filename in a header, RFC 5987.
 *
 * The plain form is ASCII-only, so a Japanese name has to travel in the
 * encoded one; the ASCII fallback is kept for anything that only understands
 * the old form, with the characters it cannot carry replaced rather than
 * dropped.
 */
export function contentDispositionFilename(name: string): string {
  const ascii = name.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "_");
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);

  // Only declare a JSON body when there actually is one. Fastify rejects a
  // request carrying `content-type: application/json` with an empty body, so
  // sending it unconditionally breaks every write with no payload — sign-out,
  // disable, restore, revoke.
  //
  // An upload sets its own content type, and must keep it: declaring JSON over
  // a file is how a binary body arrives as unparseable text.
  if (init?.body !== undefined && !headers.has("content-type")) {
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

  announcements: {
    list: () => request<{ items: AnnouncementSummary[] }>("/announcements"),
    get: (id: string) => request<AnnouncementDetail>(`/announcements/${id}`),
    create: (input: CreateAnnouncementRequest) =>
      send<AnnouncementSummary>("POST", "/announcements", input),
    revise: (id: string, input: ReviseContentRequest) =>
      send<AnnouncementSummary>("POST", `/announcements/${id}/content`, input),
    setTargets: (id: string, targets: AnnouncementTarget[]) =>
      send<{ targetVersionNo: number; resolvedUserCount: number }>(
        "PUT",
        `/announcements/${id}/targets`,
        { targets },
      ),
    setPersonalization: (id: string, userId: string, personalBody: string) =>
      send<void>("PUT", `/announcements/${id}/personalizations/${userId}`, {
        personalBody,
      }),
    publish: (id: string) =>
      send<PublishResponse>("POST", `/announcements/${id}/publish`),
    statistics: (id: string) =>
      request<AcknowledgementStatistics>(`/announcements/${id}/statistics`),
    assignObligations: (id: string) =>
      send<{ summary: CommandSummary }>(
        "POST",
        `/announcements/${id}/assign-obligations`,
        {},
      ),
    requestReacknowledgement: (id: string) =>
      send<{ summary: CommandSummary }>(
        "POST",
        `/announcements/${id}/request-reacknowledgement`,
        {},
      ),
  },

  my: {
    announcements: () => request<{ items: MyAnnouncement[] }>("/my/announcements"),
    acknowledge: (id: string) =>
      send<void>("POST", `/my/announcements/${id}/acknowledge`, { clientType: "web" }),
  },

  settings: {
    smtp: () => request<SmtpSettingsResponse>("/settings/smtp"),
    queue: () =>
      request<{ pending: number; failed: number; abandoned: number }>(
        "/settings/notification-queue",
      ),
    drainQueue: () =>
      send<{ pending: number; failed: number; abandoned: number }>(
        "POST",
        "/settings/notification-queue/drain",
        {},
      ),
  },

  /**
   * Chat lives directly under /api/v1 — `/channels`, not `/chat/channels`.
   */
  chat: {
    channels: () => request<ListChannelsResponse>("/channels"),
    createChannel: (input: CreateChannelRequest) =>
      send<{ id: string }>("POST", "/channels", input),
    openDirect: (userId: string) =>
      send<{ id: string }>("POST", "/channels/direct", { userId }),
    join: (channelId: string) => send<void>("POST", `/channels/${channelId}/join`),
    members: (channelId: string) =>
      request<ListChannelMembersResponse>(`/channels/${channelId}/members`),
    messages: (channelId: string, before?: string) => {
      const query = before ? `?before=${before}` : "";
      return request<ListMessagesResponse>(`/channels/${channelId}/messages${query}`);
    },
    sendMessage: (channelId: string, input: SendMessageRequest) =>
      send<Message>("POST", `/channels/${channelId}/messages`, input),
    /**
     * Uploads the file itself as the body.
     *
     * The name travels in Content-Disposition rather than the URL, so it never
     * reaches a proxy access log — a filename can be as revealing as the file.
     */
    uploadAttachment: (channelId: string, file: File) =>
      request<UploadAttachmentResponse>(`/channels/${channelId}/attachments`, {
        method: "POST",
        body: file,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; ${contentDispositionFilename(file.name)}`,
        },
      }),
    markRead: (channelId: string, messageId: string) =>
      send<void>("POST", `/channels/${channelId}/read`, { messageId }),
  },

  /**
   * Service accounts and their tokens.
   *
   * Every one of these refuses API-token authentication server-side: issuing a
   * token is a decision a person makes, not work an integration does.
   */
  serviceAccounts: {
    list: () => request<ListServiceAccountsResponse>("/service-accounts"),
    create: (input: CreateServiceAccountRequest) =>
      send<ServiceAccount>("POST", "/service-accounts", input),
    disable: (id: string) =>
      send<ServiceAccount>("POST", `/service-accounts/${id}/disable`),
    restore: (id: string) =>
      send<ServiceAccount>("POST", `/service-accounts/${id}/restore`),
    tokens: (id: string) =>
      request<ListApiTokensResponse>(`/service-accounts/${id}/tokens`),
    issueToken: (id: string, input: CreateApiTokenRequest) =>
      send<CreateApiTokenResponse>("POST", `/service-accounts/${id}/tokens`, input),
    revokeToken: (id: string, tokenId: string) =>
      send<void>("DELETE", `/service-accounts/${id}/tokens/${tokenId}`),
  },

  webhooks: {
    list: () => request<ListWebhooksResponse>("/webhooks"),
    create: (input: CreateWebhookRequest) =>
      send<CreateWebhookResponse>("POST", "/webhooks", input),
    disable: (id: string) => send<Webhook>("POST", `/webhooks/${id}/disable`),
    restore: (id: string) => send<Webhook>("POST", `/webhooks/${id}/restore`),
    deliveries: (id: string) =>
      request<ListWebhookDeliveriesResponse>(`/webhooks/${id}/deliveries`),
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
  NO_TARGETS: "公開する前に、宛先を1つ以上指定してください。",
  NO_RESOLVED_RECIPIENTS:
    "指定した宛先に、有効なメンバーが1人もいません。宛先を確認してください。",
  ANNOUNCEMENT_ALREADY_PUBLISHED: "この公告は既に公開されています。",
  ANNOUNCEMENT_NOT_PUBLISHED: "先に公告を公開してください。",
  ANNOUNCEMENT_ARCHIVED: "この公告はアーカイブ済みのため変更できません。",
  NO_ELIGIBLE_RECIPIENTS: "この操作の対象となるメンバーがいませんでした。",
  NOT_A_RECIPIENT: "この公告はあなたに宛てられていません。",
  SMTP_NOT_CONFIGURED: "メール送信の設定がまだ行われていません。",
  CHANNEL_FORBIDDEN: "このチャンネルに参加してから投稿してください。",
  CHANNEL_NAME_TAKEN: "同じ名前のチャンネルが既に存在します。",
  CHANNEL_ARCHIVED: "このチャンネルはアーカイブ済みのため投稿できません。",
  CANNOT_MODIFY_DIRECT: "1対1の会話のメンバーは変更できません。",
  CANNOT_MESSAGE_SELF: "自分自身との会話は作成できません。",
  REPLY_ACROSS_CHANNELS: "同じチャンネル内のメッセージにのみ返信できます。",
  ATTACHMENT_TYPE_NOT_ALLOWED:
    "この種類のファイルは添付できません。PDF・画像・Office 文書・CSV などをご利用ください。",
  ATTACHMENT_CONTENT_MISMATCH:
    "ファイルの中身が拡張子と一致しません。名前を変えただけのファイルは添付できません。",
  ATTACHMENT_TOO_LARGE: "ファイルが大きすぎます。1つあたり25MBまでです。",
  ATTACHMENT_EMPTY: "中身が空のファイルは添付できません。",
  ATTACHMENT_NAME_INVALID: "このファイル名は使用できません。",
  ATTACHMENT_NOT_CLAIMABLE:
    "添付ファイルを送信できませんでした。時間をおいてから、もう一度添付してください。",
  PAYLOAD_TOO_LARGE: "ファイルが大きすぎます。1つあたり25MBまでです。",
  TOKEN_AUTH_NOT_ALLOWED:
    "この操作は API トークンでは実行できません。担当者としてログインしてください。",
  TOKEN_INVALID: "このトークンは使用できません。停止中のサービスアカウントです。",
  NOT_A_SERVICE_ACCOUNT: "そのアカウントは担当者です。サービスアカウントではありません。",
  SERVICE_ACCOUNT_ROLE_INVALID:
    "サービスアカウントにオーナー権限は付与できません。管理者までです。",
  WEBHOOK_URL_INVALID: "http または https で始まる URL を指定してください。",
  WEBHOOK_URL_NOT_REACHABLE:
    "社内アドレス（localhost・127.0.0.1・10.x など）は指定できません。外部から到達できる URL を指定してください。",
  WEBHOOK_URL_HAS_CREDENTIALS: "URL にユーザー名やパスワードを含めることはできません。",
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
