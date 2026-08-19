import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Activity, Trophy, LayoutTemplate, Settings as SettingsIcon, X, AlertTriangle, MapPinned, Square, UserCircle, MessageCircle, Globe2, Map as MapIcon } from "lucide-react";
import {
  COST_BASE,
  ERASED,
  MIN_MAP_ZOOM,
  Z_PIXEL,
  WORLD_SIZE,
  type PaintError,
  type PaintResponse,
  type PixelInfo,
  paintCost,
  pixelToLatLng,
} from "@canvasplanet/shared";
import { api } from "./api.js";
import { WsClient } from "./ws.js";
import { solveTurnstile } from "./turnstile.js";
import { useStore } from "./store.js";
import { PaintColorTracker } from "./canvas/paintColorTracker.js";
import { MapCanvas, type MapHandle } from "./components/MapCanvas.js";
import type { GlobeHandle, GlobeView } from "./components/GlobeCanvas.js";
import { PalettePanel } from "./components/Palette.js";
import { ChargeBar } from "./components/ChargeBar.js";
import { EventBanner } from "./components/EventBanner.js";
import { LeaderboardPanel } from "./components/LeaderboardPanel.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { AdminPanel } from "./components/AdminPanel.js";
import { UserAvatar } from "./components/UserAvatar.js";
import { ActivityPanel } from "./components/ActivityPanel.js";
import { PixelInspector } from "./components/PixelInspector.js";
import { CountryPage } from "./components/CountryPage.js";
import { SharedTemplateBar } from "./components/SharedTemplateBar.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { CanvasToolsPanel } from "./components/CanvasToolsPanel.js";
import { AccountPanel } from "./components/AccountPanel.js";
import { StatusPanel } from "./components/StatusPanel.js";
import { DiscordIcon, DiscordPanel } from "./components/DiscordPanel.js";

// MapLibre is a substantial WebGL renderer. Keep it out of the flat editor's
// initial bundle and fetch it only after the player asks for the globe.
const GlobeCanvas = lazy(() => import("./components/GlobeCanvas.js"));
const GLOBE_TELEPORT_ZOOM = 6;

export function App() {
  const { ready, hydrate, setBank, setLeaderboard, panel, setPanel, togglePanel, openCountry, mapPicking, user, frozen, event, pps } =
    useStore();
  const [zoom, setZoom] = useState(Z_PIXEL);
  const [viewMode, setViewMode] = useState<"map" | "globe">(readViewMode);
  const [globeStart, setGlobeStart] = useState<GlobeView>(readGlobeStart);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [bootError, setBootError] = useState(false);
  const toastId = useRef(0);
  const showToast = useCallback((text: string) => {
    setToast({ id: ++toastId.current, text });
  }, []);
  const [hoverInfo, setHoverInfo] = useState<PixelInfo | null>(null);
  const [pinnedInfo, setPinnedInfo] = useState<PixelInfo | null>(null);
  // Chat stays out of the way until the player chooses to open it.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const chatOpenRef = useRef(chatOpen);
  useEffect(() => { chatOpenRef.current = chatOpen; }, [chatOpen]);

  const ws = useRef<WsClient | null>(null);
  const handle = useRef<MapHandle | null>(null);
  const globeHandle = useRef<GlobeHandle | null>(null);
  const flatZoom = useRef<number | null>(null);
  /** Pixel info cache, so hovering back over a pixel costs nothing. */
  const pixelCache = useRef(new Map<number, PixelInfo>());
  /** Colours learned from pixel info, live frames, and optimistic paints. */
  const paintColors = useRef(new PaintColorTracker());
  const hoverTimer = useRef<number | null>(null);

  const switchToGlobe = useCallback(() => {
    const map = handle.current?.map;
    if (map) {
      const center = map.getCenter();
      flatZoom.current = map.getZoom();
      // Enter the mode at a recognisably global scale. MapLibre deliberately
      // becomes flat at painting zoom so staying at z12 would make the toggle
      // appear to have done nothing.
      setGlobeStart({ lat: center.lat, lng: center.lng, z: Math.min(map.getZoom(), 2.25) });
    }
    setViewMode("globe");
    saveViewMode("globe");
  }, []);

  const switchToMap = useCallback(() => {
    const view = globeHandle.current?.getView();
    globeHandle.current = null;
    if (view && handle.current) {
      handle.current.map.setView([view.lat, view.lng], Math.max(MIN_MAP_ZOOM, flatZoom.current ?? Math.round(view.z)), {
        animate: false,
      });
    }
    setViewMode("map");
    saveViewMode("map");
  }, []);

  const switchToMapAt = useCallback((target: { lat: number; lng: number }) => {
    globeHandle.current = null;
    if (handle.current) {
      handle.current.map.setView(
        [target.lat, target.lng],
        Math.max(GLOBE_TELEPORT_ZOOM, flatZoom.current ?? GLOBE_TELEPORT_ZOOM),
        { animate: false },
      );
    }
    setViewMode("map");
    saveViewMode("map");
  }, []);

  // Rectangle and point selection use Leaflet-owned interaction handles.
  // Bring those tools back to their editor as soon as selection begins.
  useEffect(() => {
    if (mapPicking && viewMode === "globe") switchToMap();
  }, [mapPicking, switchToMap, viewMode]);

  // ---- boot ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    let attempts = 0;

    const load = () => {
      void api.bootstrap().then((boot) => {
      if (cancelled) return;
      attempts = 0;
      setBootError(false);
      hydrate(boot);

      // /api/auth/verify redirects back here with a flag (the emailed link
      // is a plain browser navigation, not a fetch call — see routes/auth.ts)
      // rather than the app polling to find out it happened.
      const params = new URLSearchParams(location.search);
      if (params.has("verified")) {
        showToast(boot.user ? `Welcome, ${boot.user.displayName}!` : "Email verified — you're signed in.");
        params.delete("verified");
        history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : ""));
      } else if (params.has("verify_error")) {
        showToast("That verification link is invalid or has expired.");
        params.delete("verify_error");
        history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : ""));
      } else if (params.has("discord")) {
        showToast(boot.user ? `Welcome, ${boot.user.displayName}!` : "Signed in with Discord.");
        params.delete("discord");
        history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : ""));
      } else if (params.has("discord_error")) {
        showToast("Could not sign in with Discord — try again.");
        params.delete("discord_error");
        history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : ""));
      }

      // An emailed password-reset link — held in the store rather than left
      // in the URL (a token is a live credential; stripping it immediately
      // keeps it out of browser history / any screen-share of the address
      // bar). The Account panel reads it to show the "choose a new
      // password" form instead of the login form.
      const resetToken = params.get("resetToken");
      if (resetToken) {
        useStore.setState({ pendingResetToken: resetToken, panel: "account" });
        params.delete("resetToken");
        history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : ""));
      }

      // Only now: /ws refuses a connection without a session cookie, and
      // bootstrap is what issues it. Connecting in parallel would race.
      const client = new WsClient({
        onCharges: (bank, nextAt) => setBank(bank, nextAt),
        onLeaderboard: (world, rows) => setLeaderboard(world, rows),
        onAllianceLeaderboard: (rows) => useStore.setState({ allianceLeaderboard: rows }),
        onUserLeaderboard: (rows) => useStore.setState({ playerLeaderboard: rows }),
        onFreeze: (on) => useStore.setState({ frozen: on }),
        onEvent: (event) => useStore.setState({ event }),
        onChatMessage: (message) => {
          useStore.getState().mergeChatMessages([message]);
          if (!chatOpenRef.current) setChatUnread((count) => Math.min(99, count + 1));
        },
        onChatUpdate: (message) => useStore.getState().mergeChatMessages([message]),
        onPixels: (pixels) => {
          handle.current?.overlay.add(pixels);
          globeHandle.current?.applyPixels(pixels);
          // Keep the template's notion of the canvas current from the same
          // stream, so its progress counter tracks other people's paints as
          // well as your own without re-reading the region.
          let touched = false;
          for (const [x, y, c] of pixels) {
            const color = c === ERASED ? null : c;
            paintColors.current.observe(x, y, color);
            const k = x * WORLD_SIZE + y;
            const known = pixelCache.current.get(k);
            if (known) pixelCache.current.set(k, { ...known, color });
            if (handle.current?.template.applyPaint(x, y, c)) touched = true;
          }
          if (touched) useStore.setState((s) => ({ templateTick: s.templateTick + 1 }));
        },
        onPulse: ({ pps, history = [], recent, active = [] }) => {
          // Turn each one-second country sample into compact timeline groups;
          // the richer minute-long totals and chart are server-owned.
          const at = Date.now();
          const eventCounts = new Map<number, number>();
          for (const countryId of recent) {
            eventCounts.set(countryId, (eventCounts.get(countryId) ?? 0) + 1);
          }
          useStore.setState((s) => ({
            pps,
            pulseHistory: history,
            activeCountries: active,
            activityEvents: recent.length
              ? [
                  ...s.activityEvents,
                  ...[...eventCounts].map(([countryId, count], index) => ({ id: at + index, countryId, count, at })),
                ].slice(-40)
              : s.activityEvents,
          }));
        },
        // A reconnecting client missed every paint made while it was gone.
        // Those live in the tile PNGs, not the stream, so refetching tiles is
        // what heals the gap — replaying the stream is not possible.
        onReconnect: () => handle.current?.refreshTiles(),
      });
      client.connect();
      ws.current = client;
      }).catch(() => {
        if (cancelled) return;
        setBootError(true);
        const delay = Math.min(1000 * 2 ** Math.min(attempts++, 4), 10_000);
        retryTimer = window.setTimeout(load, delay);
      });
    };

    load();

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      // Handlers above close over this render's `handle`/store setters; an
      // un-disconnected socket would keep calling them after unmount (see
      // ws.ts's disconnect() doc — EmbedApp.tsx hit exactly this).
      ws.current?.disconnect();
      ws.current = null;
    };
  }, [hydrate, setBank, setLeaderboard]);

  // ---- hover: fetch the pixel for the inspector and the paint-cost guess ----
  // Terrain is server-side only, so neither can be
  // computed client-side without asking. Debounced and cached, this is one
  // small request per hover-settle.
  const onHover = useCallback((pixel: { x: number; y: number } | null) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    useStore.setState({ hoverPixel: pixel });
    if (!pixel) {
      setHoverInfo(null);
      return;
    }

    const k = pixel.x * WORLD_SIZE + pixel.y;
    const cached = pixelCache.current.get(k);
    if (cached) {
      setHoverInfo(cached);
      return;
    }

    hoverTimer.current = window.setTimeout(() => {
      const revision = paintColors.current.revision(pixel.x, pixel.y);
      void api.pixel(pixel.x, pixel.y).then((info) => {
        if (pixelCache.current.size > 2000) pixelCache.current.clear();
        if (paintColors.current.observeIfRevision(pixel.x, pixel.y, revision, info.color)) {
          pixelCache.current.set(k, info);
        }
        // Ignore a response for a pixel the cursor has already left.
        const now = useStore.getState().hoverPixel;
        if (now && now.x === pixel.x && now.y === pixel.y) setHoverInfo(info);
      });
    }, 150);
  }, []);

  /** Right-click / long-press pins the inspector on a pixel. */
  const onInspect = useCallback((pixel: { x: number; y: number }) => {
    // Always refetch rather than trusting the hover cache: a pin is a
    // deliberate "tell me about this one", and the cached copy may predate
    // someone else painting over it.
    const revision = paintColors.current.revision(pixel.x, pixel.y);
    void api.pixel(pixel.x, pixel.y).then((info) => {
      if (paintColors.current.observeIfRevision(pixel.x, pixel.y, revision, info.color)) {
        pixelCache.current.set(pixel.x * WORLD_SIZE + pixel.y, info);
      }
      setPinnedInfo(info);
    });
  }, []);

  // ---- paint --------------------------------------------------------------
  /**
   * Optimistic: draw locally and decrement the bank immediately, then
   * reconcile from the server's response. On refusal, roll the pixel back out
   * of the overlay and explain why. The server is always right.
   */
  const onPaint = useCallback(async (x: number, y: number) => {
    const { selectedColor, bank } = useStore.getState();
    const k = x * WORLD_SIZE + y;

    // Shift strokes can revisit a coordinate many times before the first
    // response arrives. Remember the optimistic colour so those revisits do
    // not enqueue zero-cost server no-ops or fake-spend charges in the UI.
    const colorAttempt = paintColors.current.begin(x, y, selectedColor);
    if (!colorAttempt) return;

    // Best guess at the cost so the bank does not visibly jump when the
    // response lands. Falls back to the base rate for a pixel we have not
    // inspected.
    const known = pixelCache.current.get(k);
    const guess = known ? costOf(known).cost : COST_BASE;

    if (bank < guess) {
      paintColors.current.rollback(colorAttempt);
      showToast("Not enough charges yet.");
      return;
    }

    handle.current?.overlay.add([[x, y, selectedColor]]);
    useStore.getState().spendOptimistic(guess);

    let res = await api.paint(x, y, selectedColor);

    // A session's first paint is challenged with 428 and a sitekey. Solve it
    // once and retry — without this the whole anti-bot layer is unreachable
    // from the browser, blocking real users and no one else.
    if (!("ok" in res) || res.ok !== true) {
      const err = res as PaintError;
      if (err.reason === "turnstile_required" && err.turnstileSitekey) {
        try {
          const token = await solveTurnstile(err.turnstileSitekey);
          res = await api.paint(x, y, selectedColor, token);
        } catch (e) {
          if (paintColors.current.rollback(colorAttempt)) handle.current?.overlay.remove(x, y);
          showToast(e instanceof Error ? e.message : "Verification failed.");
          void api.bootstrap().then(hydrate);
          return;
        }
      }
    }

    if (!("ok" in res) || res.ok !== true) {
      const err = res as PaintError;
      if (paintColors.current.rollback(colorAttempt)) handle.current?.overlay.remove(x, y);
      showToast(
        err.reason === "no_charges" && err.retryAfterMs
          ? `Not enough charges. Ready in ${formatRetryAfter(err.retryAfterMs)}.`
          : err.message ?? "Could not paint that pixel.",
      );
      // Resync rather than guess at how far the optimistic bank drifted.
      void api.bootstrap().then(hydrate);
      return;
    }

    const ok = res as PaintResponse;
    setBank(ok.bank, ok.nextAt);
    // The pixel we just painted is now known-current; keep the cache honest
    // so the next hover shows overpaint cost rather than base cost.
    if (known) pixelCache.current.set(k, { ...known, color: selectedColor });
  }, [hydrate, setBank]);

  const onViewport = useCallback(
    (bbox: { x0: number; y0: number; x1: number; y1: number }, z: number) => {
      setZoom(z);
      ws.current?.setViewport(bbox, z);
    },
    [],
  );

  const onReady = useCallback((h: MapHandle) => {
    handle.current = h;
    // A shared template link: /t/<uuid>. Load it, place it where its author
    // placed it, and fly there. Done here rather than at boot because it
    // needs the map to exist.
    const match = /^\/t\/([0-9a-f-]{36})$/i.exec(location.pathname);
    if (!match) return;
    void api
      .loadTemplate(match[1]!)
      .then((t) => {
        h.template.set({
          x: t.x,
          y: t.y,
          w: t.w,
          h: t.h,
          data: Uint8Array.from(atob(t.data), (ch) => ch.charCodeAt(0)),
        });
        h.fitTemplate(t.x, t.y, t.w, t.h);
        useStore.setState({ sharedTemplateId: t.id });
        return api.region({ x0: t.x, y0: t.y, x1: t.x + t.w - 1, y1: t.y + t.h - 1 });
      })
      .then((r) => {
        if (r) h.template.setActual(Uint8Array.from(atob(r.data), (ch) => ch.charCodeAt(0)));
      })
      .catch(() => showToast("That template link is no longer available."));
  }, []);

  if (!ready) {
    return <div className="cp-boot">{bootError ? "The server is waking up — retrying…" : "Loading the canvas…"}</div>;
  }

  return (
    <div className="cp-app">
      <MapCanvas
        active={viewMode === "map"}
        inactiveZoom={zoom}
        onPaint={onPaint}
        onHover={onHover}
        onInspect={onInspect}
        onReady={onReady}
        onViewport={onViewport}
      />
      {viewMode === "globe" && (
        <Suspense fallback={<div className="cp-globe-view cp-boot">Loading the globe…</div>}>
          <GlobeCanvas
            initialView={globeStart}
            onPaint={onPaint}
            onHover={onHover}
            onInspect={onInspect}
            onOpenMap={switchToMapAt}
            onReady={(globe) => {
              globeHandle.current = globe;
            }}
            onViewport={onViewport}
            onUnavailable={() => {
              showToast("3D globe view needs WebGL. Switched back to the map.");
              switchToMap();
            }}
          />
        </Suspense>
      )}

      <div className="cp-hud">
        {frozen && (
          <div className="cp-frozen-banner">
            <AlertTriangle size={15} />
            The canvas is temporarily frozen.
          </div>
        )}
        {event && (
          <EventBanner
            event={event}
            onLocate={() =>
              (viewMode === "globe" ? globeHandle.current : handle.current)?.flyTo(
                Math.round((event.bbox.x0 + event.bbox.x1) / 2),
                Math.round((event.bbox.y0 + event.bbox.y1) / 2),
                15,
              )
            }
          />
        )}
        <div className="cp-topbar">
          <ChargeBar />
        </div>
      </div>

      <nav className="cp-dock cp-card" aria-label="Main controls">
        <span className="cp-dock-brand" aria-label="CanvasPlanet">
          <MapPinned size={18} />
        </span>
        <button
          className="cp-dock-btn"
          aria-pressed={panel === "activity"}
          aria-label="Live activity"
          title="Live activity"
          onClick={() => togglePanel("activity")}
        >
          <Activity size={19} />
          <span className={pps > 0 ? "cp-activity-indicator is-live" : "cp-activity-indicator"} aria-hidden />
        </button>
        <button
          className="cp-dock-btn"
          aria-pressed={panel === "tools"}
          aria-label="Canvas tools"
          title="Canvas tools"
          onClick={() => togglePanel("tools")}
        >
          <LayoutTemplate size={19} />
        </button>
        <button
          className="cp-dock-btn cp-dock-btn-discord"
          aria-pressed={panel === "discord"}
          aria-label="Discord community"
          title="Discord community"
          onClick={() => togglePanel("discord")}
        >
          <DiscordIcon />
        </button>
        <button
          className="cp-dock-btn"
          aria-pressed={panel === "account"}
          aria-label="Account"
          title={user ? user.displayName : "Sign in"}
          onClick={() => togglePanel("account")}
        >
          {user ? (
            <UserAvatar userId={user.id} name={user.displayName} revision={user.avatarRevision} size={25} />
          ) : (
            <UserCircle size={19} />
          )}
        </button>
        <button
          className="cp-dock-btn"
          aria-pressed={panel === "settings" || panel === "admin"}
          aria-label="Settings"
          title="Settings"
          onClick={() => togglePanel("settings")}
        >
          <SettingsIcon size={19} />
        </button>
      </nav>

      <div className="cp-explore-stack cp-card" role="group" aria-label="Explore views">
        <button
          aria-pressed={viewMode === "globe"}
          aria-label={viewMode === "globe" ? "Switch to flat map" : "Switch to 3D globe"}
          title={viewMode === "globe" ? "Switch to flat map" : "Switch to 3D globe"}
          onClick={viewMode === "globe" ? switchToMap : switchToGlobe}
        >
          {viewMode === "globe" ? <MapIcon size={18} /> : <Globe2 size={18} />}
        </button>
        <button
          aria-pressed={panel === "leaderboard"}
          aria-label="Leaderboard"
          title="Leaderboard"
          onClick={() => togglePanel("leaderboard")}
        >
          <Trophy size={18} />
        </button>
      </div>

      {panel === "activity" && <ActivityPanel />}
      {panel === "leaderboard" && <LeaderboardPanel />}
      {panel === "tools" && <CanvasToolsPanel handle={handle.current} />}
      {chatOpen && (
        <ChatPanel
          onClose={() => {
            chatOpenRef.current = false;
            setChatOpen(false);
          }}
          onLogin={() => setPanel("account")}
        />
      )}
      <button
        className="cp-chat-toggle cp-card"
        aria-controls="world-chat-panel"
        aria-expanded={chatOpen}
        aria-label={chatUnread > 0 ? `World chat, ${chatUnread} unread` : chatOpen ? "Close world chat" : "Open world chat"}
        title={chatOpen ? "Close world chat" : "Open world chat"}
        onClick={() => {
          setChatOpen((open) => {
            const next = !open;
            chatOpenRef.current = next;
            if (next) setChatUnread(0);
            return next;
          });
        }}
      >
        {chatOpen ? <X size={20} /> : <MessageCircle size={20} />}
        {chatUnread > 0 && <span className="cp-chat-badge">{chatUnread}</span>}
      </button>

      <SharedTemplateBar handle={handle.current} />

      {/* A pin wins over hover, so moving the mouse does not wipe what you
          deliberately asked to keep on screen. */}
      {(pinnedInfo ?? hoverInfo) && (
        <PixelInspector
          info={(pinnedInfo ?? hoverInfo)!}
          pinned={pinnedInfo !== null}
          onUnpin={() => setPinnedInfo(null)}
        />
      )}

      <PalettePanel zoom={zoom} />

      {/* Hidden rather than unmounted while picking: unmounting would throw
          away the tab's in-progress state (the loaded image, the typed
          region name) the moment you reached for the map. */}
      {(panel === "settings" ||
        panel === "admin" ||
        panel === "country" ||
        panel === "status" ||
        panel === "discord" ||
        panel === "account") && (
        <div
          className={mapPicking ? "cp-modal-backdrop cp-hidden" : "cp-modal-backdrop"}
          onClick={() => setPanel("none")}
        >
          <div
            className="cp-modal cp-card"
            role="dialog"
            aria-modal="true"
            aria-label={
              panel === "account"
                ? "Account"
                : panel === "country"
                  ? "Country"
                  : panel === "admin"
                    ? "Administration"
                    : panel === "discord"
                      ? "Discord community"
                      : panel === "status"
                        ? "System status"
                        : "Settings"
            }
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") setPanel("none");
            }}
          >
            <button className="cp-modal-close" aria-label="Close" onClick={() => setPanel("none")}>
              <X size={18} />
            </button>
            {panel === "settings" && <SettingsPanel />}
            {panel === "status" && <StatusPanel />}
            {panel === "discord" && <DiscordPanel />}
            {panel === "account" && <AccountPanel />}
            {panel === "admin" && <AdminPanel handle={handle.current} />}
            {panel === "country" && openCountry && (
              <CountryPage
                iso={openCountry}
                onFlyTo={(x, y) => (viewMode === "globe" ? globeHandle.current : handle.current)?.flyTo(x, y)}
              />
            )}
          </div>
        </div>
      )}

      {mapPicking && (
        <div className="cp-picking cp-card" role="status">
          <Square size={15} />
          Drag a rectangle on the map
          <em className="cp-hint">Esc to cancel</em>
        </div>
      )}

      {toast && (
        <div key={toast.id} className="cp-toast cp-card" role="status" onAnimationEnd={() => setToast(null)}>
          <AlertTriangle size={15} />
          {toast.text}
        </div>
      )}
    </div>
  );
}

/** Runs the same shared cost function the server uses as the authority. */
function costOf(info: PixelInfo): { cost: number; reason: string } {
  const { selectedColor } = useStore.getState();
  return paintCost({
    currentColor: info.color,
    newColor: selectedColor,
    terrain: info.terrain,
  });
}

function formatRetryAfter(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function readViewMode(): "map" | "globe" {
  // Shared template placement is an editor workflow; opening one should not
  // hide its ghost behind a remembered exploration preference.
  if (/^\/t\/[0-9a-f-]{36}$/i.test(location.pathname)) return "map";
  if (new URLSearchParams(location.search).get("view") === "globe") return "globe";
  try {
    return localStorage.getItem("cp-view-mode") === "globe" ? "globe" : "map";
  } catch {
    return "map";
  }
}

function saveViewMode(mode: "map" | "globe"): void {
  try {
    localStorage.setItem("cp-view-mode", mode);
  } catch {
    // Storage can be disabled without making the view toggle unusable.
  }
}

function readGlobeStart(): GlobeView {
  const match = /^#(\d+)\/(\d+)\/(\d+)$/.exec(location.hash);
  if (match) {
    const z = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    if (z >= 0 && z <= 18 && x >= 0 && y >= 0 && x < WORLD_SIZE && y < WORLD_SIZE) {
      const center = pixelToLatLng({ x, y });
      return { ...center, z };
    }
  }
  return { lat: 0, lng: 0, z: 1.5 };
}
