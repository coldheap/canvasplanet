/**
 * Client state.
 *
 * The one rule that matters here: the server is always right. The bank shown
 * on screen is optimistic between a click and its response, and is replaced
 * by the server's number the moment it arrives. Never the other way round.
 */

import {
  CHARGE_MAX,
  CHARGE_REGEN_MS,
  type AllianceDTO,
  type AllianceLbRow,
  type BootstrapResponse,
  type ChatMessageDTO,
  type CountryDTO,
  type EventStateDTO,
  type LbRow,
  type UserDTO,
  type UserLbRow,
} from "@canvasplanet/shared";
import { create } from "zustand";
import { isNewerChargeSnapshot, localChargeDeadline } from "./chargeClock.js";

export interface Settings {
  grid: "auto" | "on" | "off";
  sound: boolean;
  notifyWhenFull: boolean;
  /** Whole-app dark theme — see the `html.cp-dark` block in styles.css.
   *  Deliberately leaves the map's own basemap tiles alone. */
  darkMode: boolean;
  reduceMotion: "system" | "on" | "off";
  /** Paint-density overlay in place of colour — see canvas/heatLayer.ts. */
  heatmap: boolean;
  /** OSM raster basemap (roads/labels/land) under the pixel canvas. Off by
   *  default — the default view is the pixels themselves, unobscured. */
  osmLayer: boolean;
  /** Ring every pixel someone else paints, for the ~1.5s after it lands — see
   *  canvas/pixelHighlights.ts. Off by default: it is a watcher's tool, and on
   *  a busy region it is the last thing you want while placing your own art. */
  highlightNewPixels: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  // Off by default. Gridlines help when you are placing pixels deliberately,
  // but on first load they read as chrome over the map rather than part of
  // it. Settings has "auto" (on at z14+) for people who want them back.
  grid: "off",
  sound: true,
  notifyWhenFull: false,
  darkMode: false,
  reduceMotion: "system",
  heatmap: false,
  osmLayer: false,
  highlightNewPixels: false,
};

interface State {
  ready: boolean;
  bank: number;
  max: number;
  nextAt: number | null;
  regenMs: number;
  /** Latest server snapshot, kept separately while optimistic paints settle. */
  settledBank: number;
  settledNextAt: number | null;
  bankVersion: number;
  bankSnapshotAt: number;
  /**
   * Charges held aside for paints whose response has not arrived yet.
   *
   * `bank` is always `settledBank - reserved`, never an independently
   * mutated number. That is what makes a burst of taps add up exactly: each
   * request reserves what it will cost, each response replaces the settled
   * balance with the server's and hands its reservation back, and no
   * response can refund a paint that has not been accounted for yet.
   */
  reserved: number;
  selectedColor: number;

  /** Paints per second, from the pulse frame — drives the activity ticker. */
  pps: number;
  /** Unique player IPs currently connected to the full app. */
  activePlayers: number | null;
  /** Server-owned rolling minute of paints-per-second samples. */
  pulseHistory: number[];
  /** [countryId, paints] ranked over the rolling minute. */
  activeCountries: Array<[number, number]>;
  /** Short client-side timeline assembled from the one-second pulse frames. */
  activityEvents: Array<{ id: number; countryId: number; count: number; at: number }>;
  world: number;
  leaderboard: LbRow[];
  countries: Map<number, CountryDTO>;
  yourCountryId: number | null;
  lbMode: "cumulative" | "held";

  alliances: AllianceDTO[];
  allianceLeaderboard: AllianceLbRow[];
  yourAllianceId: number | null;

  /** ROADMAP.md §5.2 — "your" row comes from `user`, not a separate id: a
   *  logged-out viewer has no row to pin in the first place. */
  playerLeaderboard: UserLbRow[];

  /** Oldest to newest. History pages and live WebSocket frames merge here so
   * neither path can duplicate or overwrite the other. */
  chatMessages: ChatMessageDTO[];

  frozen: boolean;
  /** Live corruption event (ROADMAP.md Phase 7), or null when none is
   *  running — drives the map's zone outline and countdown banner. */
  event: EventStateDTO | null;
  regions: BootstrapResponse["regions"];
  staff: BootstrapResponse["staff"];
  /** Logged-in player account (ROADMAP.md §5.1) — null when signed out;
   *  anonymous play works identically either way. */
  user: UserDTO | null;
  verified: boolean;
  turnstileSitekey: string | null;
  /** Mirrors env.discord.enabled server-side — hides the "Continue with
   *  Discord" button rather than offering a flow that would 404. */
  discordEnabled: boolean;

  settings: Settings;
  /** Selected historical canvas timestamp, or null for the live canvas. */
  historyAt: number | null;
  panel:
    | "none"
    | "activity"
    | "tools"
    | "leaderboard"
    | "settings"
    | "admin"
    | "country"
    | "status"
    | "discord"
    | "account";
  /** ISO alpha-2 of the country whose page is open. */
  openCountry: string | null;
  /**
   * True while an admin is dragging a selection on the map. The modal has to
   * step aside for the duration — its backdrop covers the map, so otherwise
   * "Draw on map" is a button you can press but never complete.
   */
  mapPicking: boolean;
  /**
   * Bumped whenever a paint lands inside the active template, so the panel
   * re-reads its progress. The template state itself lives on the map layer,
   * not in the store — copying a 262k-entry array into React state on every
   * paint would be absurd — so this is just a change signal.
   */
  templateTick: number;
  /** Set when the page was opened via a /t/:id share link. */
  sharedTemplateId: string | null;
  /** Set when the page was opened via an emailed password-reset link
   *  (?resetToken=...) — the Account panel opens straight to the "choose a
   *  new password" form instead of login/signup. Cleared once consumed. */
  pendingResetToken: string | null;

  hydrate: (b: BootstrapResponse) => void;
  /**
   * Advance the balance locally once the countdown lands.
   *
   * The server only pushes charges on connect and after a spend, so an idle
   * tab would otherwise sit at a stale number until it painted again. This
   * moves the *settled* balance, never the displayed one: `bank` already has
   * in-flight reservations subtracted out of it, and adding a regenerated
   * charge to that and storing the result would subtract them a second time.
   */
  regenerateLocally: () => void;
  syncBank: (
    bank: number,
    nextAt: number | null,
    bankVersion: number,
    serverNow: number,
  ) => void;
  /** Hold `cost` charges aside for a paint that has just been sent. */
  reserveCharges: (cost: number) => void;
  /** Hand back a reservation once its paint has been answered either way. */
  releaseCharges: (cost: number) => void;
  setLeaderboard: (world: number, rows: LbRow[]) => void;
  setAllianceLeaderboard: (rows: AllianceLbRow[]) => void;
  /** Full refresh of names/colours — the panel calls this after create/join/
   *  leave and on open, since (unlike stats) a new alliance is not pushed
   *  over the socket. */
  setAlliances: (list: AllianceDTO[], rows: AllianceLbRow[]) => void;
  setYourAlliance: (id: number | null) => void;
  /** Set on login/signup-verify and cleared on logout — everywhere else
   *  `user` only ever changes via a fresh hydrate(). */
  setUser: (user: UserDTO | null) => void;
  setEvent: (event: EventStateDTO | null) => void;
  setPendingResetToken: (token: string | null) => void;
  mergeChatMessages: (messages: ChatMessageDTO[]) => void;
  select: (color: number) => void;
  setHistoryAt: (at: number | null) => void;
  setPanel: (panel: State["panel"]) => void;
  togglePanel: (panel: State["panel"]) => void;
  openCountryPage: (iso: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
}

export const useStore = create<State>((set) => ({
  ready: false,
  bank: 0,
  max: CHARGE_MAX,
  nextAt: null,
  regenMs: CHARGE_REGEN_MS,
  settledBank: 0,
  settledNextAt: null,
  bankVersion: -1,
  bankSnapshotAt: Number.NEGATIVE_INFINITY,
  reserved: 0,
  selectedColor: 0,

  pps: 0,
  activePlayers: null,
  pulseHistory: [],
  activeCountries: [],
  activityEvents: [],
  world: 0,
  leaderboard: [],
  countries: new Map(),
  yourCountryId: null,
  lbMode: "cumulative",

  alliances: [],
  allianceLeaderboard: [],
  yourAllianceId: null,

  playerLeaderboard: [],
  chatMessages: [],

  frozen: false,
  event: null,
  regions: [],
  staff: null,
  user: null,
  verified: false,
  turnstileSitekey: null,
  discordEnabled: false,

  settings: loadSettings(),
  historyAt: null,
  panel: "none",
  openCountry: null,
  mapPicking: false,
  templateTick: 0,
  sharedTemplateId: null,
  pendingResetToken: null,

  hydrate: (b) =>
    set((s) => ({
      ready: true,
      max: b.max,
      regenMs: b.regenMs,
      world: b.world,
      leaderboard: b.leaderboard,
      countries: new Map(b.countries.map((c) => [c.id, c])),
      yourCountryId: b.yourCountryId,
      alliances: b.alliances,
      allianceLeaderboard: b.allianceLeaderboard,
      yourAllianceId: b.yourAllianceId,
      playerLeaderboard: b.playerLeaderboard,
      frozen: b.frozen,
      event: b.event,
      regions: b.regions,
      staff: b.staff,
      user: b.user,
      verified: b.verified,
      turnstileSitekey: b.turnstileSitekey,
      discordEnabled: b.discordEnabled,
      ...chargeSnapshotPatch(s, b.bank, b.nextAt, b.bankVersion, b.serverNow),
    })),

  regenerateLocally: () =>
    set((s) => {
      const now = Date.now();
      if (s.settledNextAt === null || s.settledBank >= s.max || now < s.settledNextAt) return {};
      // Catch up on however many periods actually elapsed: a backgrounded tab
      // is throttled to far less than one tick a second.
      const gained = Math.min(s.max - s.settledBank, 1 + Math.floor((now - s.settledNextAt) / s.regenMs));
      const settledBank = s.settledBank + gained;
      const settledNextAt = settledBank >= s.max ? null : s.settledNextAt + gained * s.regenMs;
      return {
        settledBank,
        settledNextAt,
        bank: visibleBank(settledBank, s.reserved, s.max),
        nextAt: settledNextAt,
      };
    }),
  syncBank: (bank, nextAt, bankVersion, serverNow) =>
    set((s) => chargeSnapshotPatch(s, bank, nextAt, bankVersion, serverNow)),
  reserveCharges: (cost) =>
    set((s) => {
      const reserved = s.reserved + cost;
      const bank = visibleBank(s.settledBank, reserved, s.max);
      return {
        reserved,
        bank,
        // Spending from a full bank is the one transition where nextAt is
        // still null. Start the countdown locally while the paint request is
        // in flight; the authoritative response will replace it shortly.
        nextAt: bank < s.max && s.nextAt === null ? Date.now() + s.regenMs : s.nextAt,
      };
    }),
  releaseCharges: (cost) =>
    set((s) => {
      const reserved = Math.max(0, s.reserved - cost);
      return { reserved, bank: visibleBank(s.settledBank, reserved, s.max) };
    }),
  setLeaderboard: (world, leaderboard) => set({ world, leaderboard }),
  setAllianceLeaderboard: (allianceLeaderboard) => set({ allianceLeaderboard }),
  setAlliances: (alliances, allianceLeaderboard) => set({ alliances, allianceLeaderboard }),
  setYourAlliance: (yourAllianceId) => set({ yourAllianceId }),
  setUser: (user) => set({ user }),
  setEvent: (event) => set({ event }),
  setPendingResetToken: (pendingResetToken) => set({ pendingResetToken }),
  mergeChatMessages: (messages) =>
    set((state) => {
      const byId = new Map(state.chatMessages.map((message) => [message.id, message]));
      for (const message of messages) byId.set(message.id, message);
      // A tab left open in a very active room must not grow forever. The DB
      // keeps the full moderation history; the compact on-screen window only
      // needs a generous recent tail.
      const sorted = [...byId.values()].sort((a, b) => a.id - b.id);
      return { chatMessages: sorted.length > 500 ? sorted.slice(-500) : sorted };
    }),
  select: (selectedColor) => set({ selectedColor }),
  setHistoryAt: (historyAt) => set({ historyAt }),
  setPanel: (panel) => set({ panel }),
  togglePanel: (panel) => set((state) => ({ panel: state.panel === panel ? "none" : panel })),
  openCountryPage: (openCountry) => set({ openCountry, panel: "country" }),
  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      // Settings are cosmetic and per-device, so localStorage is fine here.
      // The session token deliberately is not — it stays httpOnly.
      localStorage.setItem("cp_settings", JSON.stringify(settings));
      if (patch.reduceMotion) applyMotionClass(patch.reduceMotion);
      if (patch.darkMode !== undefined) applyThemeClass(patch.darkMode);
      return { settings };
    }),
}));

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("cp_settings");
    const settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
    applyMotionClass(settings.reduceMotion);
    applyThemeClass(settings.darkMode);
    return settings;
  } catch {
    applyMotionClass(DEFAULT_SETTINGS.reduceMotion);
    applyThemeClass(DEFAULT_SETTINGS.darkMode);
    return DEFAULT_SETTINGS;
  }
}

/** "system" leaves both classes off, so the `prefers-reduced-motion` media
 *  query in styles.css is the only thing deciding — see that rule for why an
 *  explicit "on"/"off" class still wins over it either way. */
function applyMotionClass(mode: Settings["reduceMotion"]): void {
  document.documentElement.classList.toggle("cp-motion-reduce", mode === "on");
  document.documentElement.classList.toggle("cp-motion-full", mode === "off");
}

function applyThemeClass(darkMode: boolean): void {
  document.documentElement.classList.toggle("cp-dark", darkMode);
}

/** What the charge bar shows: the settled balance minus everything in flight. */
function visibleBank(settledBank: number, reserved: number, max: number): number {
  return Math.max(0, Math.min(max, settledBank - reserved));
}

function chargeSnapshotPatch(
  state: Pick<State, "bankVersion" | "bankSnapshotAt" | "reserved" | "max">,
  bank: number,
  serverNextAt: number | null,
  bankVersion: number,
  serverNow: number,
): Partial<State> {
  if (!isNewerChargeSnapshot(bankVersion, serverNow, state.bankVersion, state.bankSnapshotAt)) {
    return {};
  }

  const nextAt = localChargeDeadline(serverNextAt, serverNow);
  return {
    bankVersion,
    bankSnapshotAt: serverNow,
    settledBank: bank,
    settledNextAt: nextAt,
    // A response for the first request in a burst has not seen the requests
    // still in flight behind it. Subtracting what they reserved is what keeps
    // that partial snapshot from visually refunding them.
    bank: visibleBank(bank, state.reserved, state.max),
    nextAt,
  };
}
