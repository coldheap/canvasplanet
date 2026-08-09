import type {
  AllianceDTO,
  AllianceLbRow,
  BootstrapResponse,
  ExportStatusResponse,
  TimelapseResponse,
  PaintError,
  PaintResponse,
  PixelInfo,
  UserDTO,
} from "@worldcanvas/shared";

async function json<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body });
  return body as T;
}

/**
 * Admin routes answer 404 rather than 403 when unauthorised, so an
 * unauthenticated prober learns nothing about which of them exist. That means
 * the client cannot distinguish "no such route" from "not signed in" — the
 * panel treats any failure as "signed out" and shows the login form.
 */
const get = <T>(path: string) =>
  fetch(path, { credentials: "same-origin" }).then(json<T>);

const post = <T>(path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(json<T>);

export const api = {
  bootstrap: () =>
    fetch("/api/bootstrap", { credentials: "same-origin" }).then(json<BootstrapResponse>),

  /**
   * Paint returns the error body rather than throwing, because every refusal
   * (cooldown, protected, frozen, IP budget) is a normal, expected outcome
   * that the UI must explain — not an exception.
   */
  async paint(
    x: number,
    y: number,
    color: number,
    turnstileToken?: string,
  ): Promise<PaintResponse | PaintError> {
    const res = await fetch("/api/paint", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x, y, color, turnstileToken }),
    });
    return res.json();
  },

  pixel: (x: number, y: number) => fetch(`/api/pixel/${x}/${y}`).then(json<PixelInfo>),

  country: (iso: string) => fetch(`/api/country/${iso}`).then(json<Record<string, unknown>>),

  timelapse: (q: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    from: number;
    to: number;
    frames: number;
  }) =>
    fetch(
      `/api/timelapse?x0=${q.x0}&y0=${q.y0}&x1=${q.x1}&y1=${q.y1}` +
        `&from=${q.from}&to=${q.to}&frames=${q.frames}`,
    ).then(json<TimelapseResponse>),

  exportTimelapse: (body: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    from: number;
    to: number;
    frames: number;
    format: "gif" | "mp4";
  }) => post<{ id: string; status: "queued" | "cached" }>("/api/export/timelapse", body),

  exportStatus: (id: string) => fetch(`/api/export/${id}`).then(json<ExportStatusResponse>),

  /** Every painted colour in a rectangle, one byte per pixel, base64. */
  region: (q: { x0: number; y0: number; x1: number; y1: number }) =>
    fetch(`/api/region?x0=${q.x0}&y0=${q.y0}&x1=${q.x1}&y1=${q.y1}`).then(
      json<{ x0: number; y0: number; w: number; h: number; painted: number; data: string }>,
    ),

  publishTemplate: (body: { x: number; y: number; w: number; h: number; data: string }) =>
    post<{ id: string; url: string }>("/api/templates", body),

  loadTemplate: (id: string) =>
    fetch(`/api/templates/${id}`).then(
      json<{ id: string; x: number; y: number; w: number; h: number; data: string }>,
    ),

  reportTemplate: (id: string) =>
    post<{ ok: boolean; counted: boolean }>(`/api/templates/${id}/report`, {}),

  reportArea: (body: { x0: number; y0: number; x1: number; y1: number; reason?: string }) =>
    post<{ ok: boolean }>("/api/report", body),

  alliances: () => get<{ alliances: AllianceDTO[]; rows: AllianceLbRow[] }>("/api/alliances"),
  allianceDetail: (id: number) =>
    get<AllianceDTO & { created_at: string; cumulative: number; held: number; rank: number | null; members: number }>(
      `/api/alliances/${id}`,
    ),
  createAlliance: (body: { name: string; color: number }) => post<AllianceDTO>("/api/alliances", body),
  joinAlliance: (id: number) => post<{ ok: boolean; allianceId: number }>(`/api/alliances/${id}/join`, {}),
  leaveAlliance: () => post<{ ok: boolean; allianceId: null }>("/api/alliances/leave", {}),

  signup: (body: { email: string; password: string; displayName: string }) =>
    post<{ ok: boolean; message: string }>("/api/auth/signup", body),
  login: (email: string, password: string) =>
    post<{ ok: boolean; user: UserDTO }>("/api/auth/login", { email, password }),
  logout: () => post<{ ok: boolean }>("/api/auth/logout", {}),
  resendVerification: (email: string) =>
    post<{ ok: boolean; message: string }>("/api/auth/resend-verification", { email }),
  requestPasswordReset: (email: string) =>
    post<{ ok: boolean; message: string }>("/api/auth/request-reset", { email }),
  resetPassword: (token: string, password: string) =>
    post<{ ok: boolean; user: UserDTO }>("/api/auth/reset", { token, password }),

  staffLogin: (username: string, password: string) =>
    fetch("/api/staff/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }).then(json<{ ok: boolean; role: "mod" | "admin"; username: string }>),

  admin: {
    stats: () => get<AdminStats>("/api/admin/stats"),

    revert: (body: RevertSelector) =>
      post<RevertResult>("/api/admin/revert", body),

    freeze: (on: boolean) => post<{ ok: boolean; frozen: boolean }>("/api/admin/freeze", { on }),

    regions: () => get<AdminRegion[]>("/api/admin/regions"),
    addRegion: (body: { name: string; x0: number; y0: number; x1: number; y1: number }) =>
      post<AdminRegion>("/api/admin/regions", body),
    removeRegion: (id: number) =>
      fetch(`/api/admin/regions/${id}`, { method: "DELETE", credentials: "same-origin" }).then(
        json<{ ok: boolean }>,
      ),

    staff: () => get<StaffRow[]>("/api/admin/staff"),
    addStaff: (body: { username: string; password: string; role: "mod" | "admin" }) =>
      post<StaffRow>("/api/admin/staff", body),
    setStaffDisabled: (id: number, disabled: boolean) =>
      post<{ ok: boolean }>(`/api/admin/staff/${id}/disable`, { disabled }),

    audit: () => get<AuditRow[]>("/api/admin/audit"),

    stamp: (body: StampRequest) => post<StampResult>("/api/admin/stamp", body),

    inspect: (x: number, y: number) =>
      get<{ history: ForensicRow[] }>(`/api/admin/inspect/${x}/${y}`),

    ban: (body: { ip?: string; sessionId?: number; hours?: number; reason?: string }) =>
      post<{ ok: boolean; until: string | null }>("/api/admin/ban", body),

    reports: (status: "open" | "dismissed" | "reverted" | "all" = "open") =>
      get<AreaReport[]>(`/api/admin/reports?status=${status}`),
    resolveReport: (id: number, action: "dismiss" | "revert") =>
      post<{ ok: boolean; revert: RevertResult | null }>(`/api/admin/reports/${id}/resolve`, { action }),

    alliances: () => get<AdminAlliance[]>("/api/admin/alliances"),
    setAllianceDisabled: (id: number, disabled: boolean) =>
      post<{ ok: boolean }>(`/api/admin/alliances/${id}/disable`, { disabled }),

    users: (q = "") => get<AdminUser[]>(`/api/admin/users?q=${encodeURIComponent(q)}`),
    setUserDisabled: (id: number, disabled: boolean) =>
      post<{ ok: boolean }>(`/api/admin/users/${id}/disable`, { disabled }),
  },
};

// ---------------------------------------------------------------------------
// Admin response shapes
// ---------------------------------------------------------------------------

export interface AdminStats {
  pps: number;
  world: number;
  ws: { clients: number; tiles: number; degraded: number };
  /** Event-loop lag. Distinguishes "the database is slow" from "something on
   *  this thread is blocking every request" — they look identical without it. */
  loop: { meanMs: number; p50Ms: number; p99Ms: number; maxMs: number };
  tileTiming: {
    query: { n: number; meanMs: number; maxMs: number };
    encode: { n: number; meanMs: number; maxMs: number };
  };
  tiles: { queue: number; lruSize: number; lruMax: number; running: boolean };
  geo: { loaded: boolean; maskCacheSize: number; fallbackRate: string };
  scoring: { tracked: number };
  topIps: Array<{ ip: string; paints: number }>;
}

export interface AdminRegion {
  id: number;
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  created_at?: string;
}

export interface StaffRow {
  id: number;
  username: string;
  role: "mod" | "admin";
  disabled_at: string | null;
  created_at?: string;
}

export interface AuditRow {
  id: number;
  staff_id: number | null;
  username: string | null;
  action: string;
  params: Record<string, unknown>;
  affected: number | null;
  created_at: string;
}

export interface ForensicRow {
  x: number;
  y: number;
  color: number;
  prev_color: number | null;
  session_id: number | null;
  staff_id: number | null;
  ip: string | null;
  session_ip: string | null;
  total_paints: number | null;
  created_at: string;
}

export interface RevertSelector {
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  sessionId?: number;
  since?: number;
  preview?: boolean;
}

export interface RevertResult {
  affected: number;
  batchId: string | null;
  preview: boolean;
}

export interface AdminAlliance {
  id: number;
  name: string;
  color: number;
  created_at: string;
  disabled_at: string | null;
  members: number;
}

export interface AdminUser {
  id: number;
  /** Null for a Discord-only account with no verified email on file. */
  email: string | null;
  display_name: string;
  email_verified_at: string | null;
  disabled_at: string | null;
  created_at: string;
  cumulative: number;
  held: number;
}

export interface AreaReport {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  reason: string | null;
  status: "open" | "dismissed" | "reverted";
  created_at: string;
  session_id: number | null;
  ip: string | null;
  resolved_by: string | null;
  suspects: Array<{ sessionId: number; ip: string | null; paints: number }>;
}

export interface StampRequest {
  x: number;
  y: number;
  w: number;
  h: number;
  data: number[];
  preview?: boolean;
  autoProtect?: boolean;
  name?: string;
}

export interface StampResult {
  pixels: number;
  violations: number;
  skippedProtected: number;
  skippedOutOfBounds: number;
  batchId: string | null;
  preview: boolean;
}
