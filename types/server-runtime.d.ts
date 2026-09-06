import type {
  BoardMessage,
  ConnectedUser,
  ModerationDisconnectPayload,
  SequencedMutationBroadcast,
  SetTemporaryModeratorPayload,
} from "./app-runtime";

export type ServerConfig = typeof import("../server/configuration.mjs");

export type HttpRequest = import("http").IncomingMessage;
export type HttpResponse = import("http").ServerResponse;

export type StaticFileServer = (
  request: HttpRequest,
  response: HttpResponse,
  next: (error?: unknown) => void,
) => void;

export type ServerRuntime = {
  config: ServerConfig;
  fileserver: StaticFileServer;
  errorPage: import("../server/http/templating.mjs").Template;
  boardTemplate: import("../server/http/templating.mjs").BoardTemplate;
  indexTemplate: import("../server/http/templating.mjs").Template;
  rulesTemplate: import("../server/http/templating.mjs").RulesTemplate;
  manifestTemplate: import("../server/http/templating.mjs").Template;
  hostedEventModule: HostedEventModule;
};

/**
 * The admission verdict for one attempt to reach an event Board Session, by
 * socket handshake or board page load. `role` maps onto board permission
 * roles: moderator (Owner/Admin, Preparation Window capable),
 * event_moderator (per-event realtime governance grant, Preparation Window
 * capable, no Clear), editor (member holding the account's single writable
 * connection), reader (explicit read-only).
 */
export type HostedBoardAdmission = ReturnType<
  typeof import("../server/hosted_event/admission/index.mjs").createEventAdmission
>;

/**
 * The event-scoped governance surface composed onto the Hosted Event Module
 * by `createEventModeration`.
 */
export type HostedEventModeration = ReturnType<
  typeof import("../server/hosted_event/moderation/index.mjs").createEventModeration
>;

export type HostedEventModule = {
  enabled: boolean;
  serveHome: HttpRouteHandler;
  serveSource: HttpRouteHandler;
  serveRegister: HttpRouteHandler;
  serveLogin: HttpRouteHandler;
  serveVerify: HttpRouteHandler;
  serveLogout: HttpRouteHandler;
  serveForgot: HttpRouteHandler;
  serveReset: HttpRouteHandler;
  serveAccount: HttpRouteHandler;
  serveAccountPassword: HttpRouteHandler;
  serveAccountSessionRevoke: HttpRouteHandler;
  serveAccountSessionsRevokeOthers: HttpRouteHandler;
  serveOrganizerApply: HttpRouteHandler;
  serveOperatorConsole: HttpRouteHandler;
  serveOperatorApplication: HttpRouteHandler;
  serveOperatorApproveApplication: HttpRouteHandler;
  serveOperatorRejectApplication: HttpRouteHandler;
  serveOrganizerConsole: HttpRouteHandler;
  serveOrganizerInvitationAccept: HttpRouteHandler;
  serveOrganizerInvitationDecline: HttpRouteHandler;
  serveOrganizerManage: HttpRouteHandler;
  serveOrganizerInvite: HttpRouteHandler;
  serveOrganizerInvitationRevoke: HttpRouteHandler;
  serveOrganizerMemberRole: HttpRouteHandler;
  serveOrganizerMemberRemove: HttpRouteHandler;
  serveOrganizerReservations: HttpRouteHandler;
  serveOrganizerReservation: HttpRouteHandler;
  serveSubmitReservation: HttpRouteHandler;
  serveCancelReservation: HttpRouteHandler;
  serveSubmitChangeRequest: HttpRouteHandler;
  serveOperatorReservations: HttpRouteHandler;
  serveOperatorReservation: HttpRouteHandler;
  serveOperatorApproveReservation: HttpRouteHandler;
  serveOperatorRejectReservation: HttpRouteHandler;
  serveOperatorChanges: HttpRouteHandler;
  serveOperatorChange: HttpRouteHandler;
  serveOperatorApproveChange: HttpRouteHandler;
  serveOperatorRejectChange: HttpRouteHandler;
  serveEventPage: HttpRouteHandler;
  serveEventEnter: HttpRouteHandler;
  serveEventAnonymity: HttpRouteHandler;
  refreshEventLifecycle: () => Promise<void>;
  registerBoardCloseEffects: (effects: {
    notifyBoardClosed: (boardName: string) => Promise<void>;
  }) => void;
  admitEventBoardSocket: HostedBoardAdmission["admitEventBoardSocket"];
  admitEventBoardPage: HostedBoardAdmission["admitEventBoardPage"];
  noteEventSocketConnected: HostedBoardAdmission["noteEventSocketConnected"];
  releaseEventSocket: HostedBoardAdmission["releaseEventSocket"];
  revalidateSocketWrite: HostedBoardAdmission["revalidateSocketWrite"];
  recordEventReport: HostedEventModeration["recordEventReport"];
  applyModeration: HostedEventModeration["applyModeration"];
  recordEntryLockChange: HostedEventModeration["recordEntryLockChange"];
  recordClear: HostedEventModeration["recordClear"];
  eventBanSummaries: HostedEventModeration["eventBanSummaries"];
  listEventModeration: HostedEventModeration["listEventModeration"];
  hasEventGovernanceRole: HostedEventModeration["hasEventGovernanceRole"];
  serveBrandAsset: HttpRouteHandler;
  serveOrganizerEvent: HttpRouteHandler;
  serveOrganizerEventAccessCode: HttpRouteHandler;
  serveOrganizerEventEntryLock: HttpRouteHandler;
  serveOrganizerEventModerators: HttpRouteHandler;
  serveOrganizerEventModeratorRevoke: HttpRouteHandler;
  serveOrganizerEventCover: HttpRouteHandler;
  serveOrganizerCredentialCreate: HttpRouteHandler;
  serveOrganizerCredentialRotate: HttpRouteHandler;
  serveOrganizerCredentialRevoke: HttpRouteHandler;
  serveEventEntryGrantRedeem: HttpRouteHandler;
  serveIntegrationApiEvent: HttpRouteHandler;
  serveIntegrationApiEntryGrantCreate: HttpRouteHandler;
};

export type ObservedHttpRequest = {
  requestId?: string;
  run: (fn: () => void | Promise<void>) => void;
  setRoute: (route: string) => void;
  noteError: (error: unknown) => void;
  annotate: (fields: { [key: string]: unknown }) => void;
  setTraceAttributes: (fields: { [key: string]: unknown }) => void;
};

export type HttpRouteContext<
  Params extends Record<string, string> = Record<string, string>,
> = {
  request: HttpRequest;
  response: HttpResponse;
  runtime: ServerRuntime;
  observed: ObservedHttpRequest;
  publicUrl: URL;
  url: URL;
  params: Params;
  /**
   * Board permission role pre-verified by hosted admission; routes that
   * delegate to the legacy board renderer pin it here so the renderer's
   * capability queries honor it without re-checking hosted rules.
   */
  hostedBoardRole?:
    | "moderator"
    | "event_moderator"
    | "editor"
    | "reader"
    | null;
  /**
   * Hosted Event board pages pin the event page path here so the board
   * shell can route terminal admission refusals back to the event page.
   */
  hostedEventPath?: string;
};

export type HttpRouteHandler<
  Params extends Record<string, string> = Record<string, string>,
> = (context: HttpRouteContext<Params>) => void | Promise<void>;

export type HttpRequestHandler = (context: {
  request: HttpRequest;
  response: HttpResponse;
  runtime: ServerRuntime;
}) => void;

export type SocketServerModule = {
  start: (
    app: import("http").Server,
    config: ServerConfig,
    runtime: ServerRuntime,
  ) => Promise<unknown>;
  shutdown?: () => Promise<void>;
};

export type ServerApp = import("http").Server & {
  shutdown?: () => Promise<void>;
};

export type MessageData = Partial<
  Record<
    | "tool"
    | "type"
    | "id"
    | "parent"
    | "newid"
    | "color"
    | "size"
    | "txt"
    | "clientMutationId"
    | "transform"
    | "_children",
    unknown
  >
>;

export type NormalizedMessageData = BoardMessage;

export type SocketRequest = {
  headers: { [key: string]: string | string[] | undefined };
  socket?: { remoteAddress?: string };
};

export type BoardPermissionResolver = ReturnType<
  typeof import("../server/auth/board_capabilities.mjs").BoardPermissions.forBoard
>;

export type SocketBoardPermissionContext = {
  boardName: string;
  permissions: BoardPermissionResolver;
};

export type AppSocket = import("socket.io").Socket & {
  boardName?: string;
  boardPermissionContext?: SocketBoardPermissionContext;
  hostedEventModule?: HostedEventModule;
  /** Admission verdict pinned by the hosted socket gate; sockets only. */
  hostedEventAdmission?: {
    role: "moderator" | "event_moderator" | "editor" | "reader";
    accountId: string;
    eventId: string;
    publicId: string;
    boardName: string;
    /** Opaque, event-scoped creator identity for items this account creates. */
    participantId: string;
    boardSessionId: string;
    seats: number;
    socketId?: string;
  };
  /** Board permission role granted by hosted admission, when admitted. */
  hostedBoardRole?: "moderator" | "event_moderator" | "editor" | "reader";
  replayBootstrap?: unknown;
  turnstileValidatedUntil?: number;
  client: { request: SocketRequest };
  handshake: {
    query?: {
      board?: string;
      token?: string;
      tool?: string;
      color?: string;
      size?: string;
      baselineSeq?: string;
    };
  };
};

export type RateLimitState = {
  windowStart: number;
  count: number;
  lastSeen: number;
};

export type TurnstileAck = {
  success: true;
  validationWindowMs: number;
  validatedUntil: number | undefined;
};

export type TurnstileRejectedAck = {
  success: false;
};

export type TurnstileEventAck = TurnstileAck | TurnstileRejectedAck | true;

export type TurnstileAckCallback = (ack: TurnstileEventAck) => void;

export type TurnstileSiteverifyResult = {
  success?: boolean;
  hostname?: unknown;
  "error-codes"?: unknown;
};

export type ReportUserPayload = {
  socketId?: string;
  banDurationMs?: number;
  moderationRule?: string;
};

export type {
  ModerationDisconnectPayload,
  ModerationDisconnectSource,
  SetTemporaryModeratorPayload,
};

export type ValidationStatus = { ok: true } | { ok: false; reason: string };

export type RejectedBroadcast = {
  ok: false;
  reason: string;
};

export type BroadcastResult =
  | {
      ok: true;
      value: NormalizedMessageData;
    }
  | RejectedBroadcast;

export type ConnectedUserPayload = ConnectedUser;

export type UserLeftPayload = {
  socketId: string;
};

export type BoardLike = {
  name: string;
  isReadOnly: () => boolean;
};

// Retained per-board replay-log state. BoardData owns the board scope, and
// sockets own source identity, so this type deliberately stores neither.
export type MutationLogEntry = {
  seq: number;
  acceptedAtMs: number;
  mutation: NormalizedMessageData;
};

export type SequencedMutationBroadcastData = SequencedMutationBroadcast & {
  mutation: NormalizedMessageData;
};
