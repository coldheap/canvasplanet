/**
 * Client state.
 *
 * The one rule that matters here: the server is always right. The bank shown
 * on screen is optimistic between a click and its response, and is replaced
 * by the server's number the moment it arrives. Never the other way round.
 */

import {
  CHARGE_MAX,
  type AllianceDTO,
  type AllianceLbRow,
  type BootstrapResponse,
  type CountryDTO,
  type LbRow,
  type UserDTO,
  type UserLbRow,
} from "@worldcanvas/shared";
import { create } from "zustand";

export interface Settings {
  grid: "auto" | "on" | "off";
  sound: boolean;
  notifyWhenFull: boolean;
  darkMap: boolean;
  reduceMotion: "system" | "on" | "off";
  /** Paint-density overlay in place of colour — see canvas/heatLayer.ts. */
  heatmap: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  // Off by default. Gridlines help when you are placing pixels deliberately,
  // but on first load they read as chrome over the map rather than part of
  // it. Settings has "auto" (on at z14+) for people who want them back.
  grid: "off",
  sound: true,
  notifyWhenFull: false,
  darkMap: false,
  reduceMotion: "system",
  heatmap: false,
};

interface State {
  ready: boolean;
  bank: number;
  max: number;
  nextAt: number | null;
  selectedColor: number;
  hoverPixel: { x: number; y: number } | null;

  /** Paints per second, from the pulse frame — drives the activity ticker. */
  pps: number;
  /** Country ids of the most recent paints, newest last. */
  recentFlags: number[];
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

  frozen: boolean;
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
  panel:
    | "none"
    | "leaderboard"
    | "settings"
    | "admin"
    | "overlay"
    | "timelapse"
    | "country"
    | "status"
    | "report"
    | "embed"
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
  setBank: (bank: number, nextAt: number | null) => void;
  /** Optimistic decrement between click and response. */
  spendOptimistic: (cost: number) => void;
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
  setPendingResetToken: (token: string | null) => void;
  select: (color: number) => void;
  setPanel: (panel: State["panel"]) => void;
  openCountryPage: (iso: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
}

export const useStore = create<State>((set) => ({
  ready: false,
  bank: 0,
  max: CHARGE_MAX,
  nextAt: null,
  selectedColor: 0,
  hoverPixel: null,

  pps: 0,
  recentFlags: [],
  world: 0,
  leaderboard: [],
  countries: new Map(),
  yourCountryId: null,
  lbMode: "cumulative",

  alliances: [],
  allianceLeaderboard: [],
  yourAllianceId: null,

  playerLeaderboard: [],

  frozen: false,
  regions: [],
  staff: null,
  user: null,
  verified: false,
  turnstileSitekey: null,
  discordEnabled: false,

  settings: loadSettings(),
  panel: "none",
  openCountry: null,
  mapPicking: false,
  templateTick: 0,
  sharedTemplateId: null,
  pendingResetToken: null,

  hydrate: (b) =>
    set({
      ready: true,
      bank: b.bank,
      max: b.max,
      nextAt: b.nextAt,
      world: b.world,
      leaderboard: b.leaderboard,
      countries: new Map(b.countries.map((c) => [c.id, c])),
      yourCountryId: b.yourCountryId,
      alliances: b.alliances,
      allianceLeaderboard: b.allianceLeaderboard,
      yourAllianceId: b.yourAllianceId,
      playerLeaderboard: b.playerLeaderboard,
      frozen: b.frozen,
      regions: b.regions,
      staff: b.staff,
      user: b.user,
      verified: b.verified,
      turnstileSitekey: b.turnstileSitekey,
      discordEnabled: b.discordEnabled,
    }),

  setBank: (bank, nextAt) => set({ bank, nextAt }),
  spendOptimistic: (cost) => set((s) => ({ bank: Math.max(0, s.bank - cost) })),
  setLeaderboard: (world, leaderboard) => set({ world, leaderboard }),
  setAllianceLeaderboard: (allianceLeaderboard) => set({ allianceLeaderboard }),
  setAlliances: (alliances, allianceLeaderboard) => set({ alliances, allianceLeaderboard }),
  setYourAlliance: (yourAllianceId) => set({ yourAllianceId }),
  setUser: (user) => set({ user }),
  setPendingResetToken: (pendingResetToken) => set({ pendingResetToken }),
  select: (selectedColor) => set({ selectedColor }),
  setPanel: (panel) => set({ panel }),
  openCountryPage: (openCountry) => set({ openCountry, panel: "country" }),
  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch };
      // Settings are cosmetic and per-device, so localStorage is fine here.
      // The session token deliberately is not — it stays httpOnly.
      localStorage.setItem("wc_settings", JSON.stringify(settings));
      return { settings };
    }),
}));

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("wc_settings");
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}
