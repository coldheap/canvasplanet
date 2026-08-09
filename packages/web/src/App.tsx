import { useCallback, useEffect, useRef, useState } from "react";
import { Trophy, LayoutTemplate, Settings as SettingsIcon, X, AlertTriangle, MapPinned, Square, Clapperboard, Flag, Code2, UserCircle } from "lucide-react";
import {
  Z_PIXEL,
  type PaintError,
  type PaintResponse,
  type PixelInfo,
  paintCost,
} from "@worldcanvas/shared";
import { api } from "./api.js";
import { WsClient } from "./ws.js";
import { solveTurnstile } from "./turnstile.js";
import { useStore } from "./store.js";
import { MapCanvas, type MapHandle } from "./components/MapCanvas.js";
import { PalettePanel } from "./components/Palette.js";
import { ChargeBar } from "./components/ChargeBar.js";
import { LeaderboardPanel } from "./components/LeaderboardPanel.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { AdminPanel } from "./components/AdminPanel.js";
import { OverlayTool } from "./components/OverlayTool.js";
import { ReportTool } from "./components/ReportTool.js";
import { AccountPanel } from "./components/AccountPanel.js";
import { EmbedTool } from "./components/EmbedTool.js";
import { ActivityFeed } from "./components/ActivityFeed.js";
import { PixelInspector } from "./components/PixelInspector.js";
import { CountryPage } from "./components/CountryPage.js";
import { StatusPanel } from "./components/StatusPanel.js";
import { TimelapsePanel } from "./components/TimelapsePanel.js";
import { SharedTemplateBar } from "./components/SharedTemplateBar.js";

export function App() {
  const { ready, hydrate, setBank, setLeaderboard, panel, setPanel, openCountry, mapPicking, user } = useStore();
  const [zoom, setZoom] = useState(Z_PIXEL);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const toastId = useRef(0);
  const showToast = useCallback((text: string) => {
    setToast({ id: ++toastId.current, text });
  }, []);
  const [hoverInfo, setHoverInfo] = useState<PixelInfo | null>(null);
  const [pinnedInfo, setPinnedInfo] = useState<PixelInfo | null>(null);

  const ws = useRef<WsClient | null>(null);
  const handle = useRef<MapHandle | null>(null);
  /** Pixel info cache, so hovering back over a pixel costs nothing. */
  const pixelCache = useRef(new Map<number, PixelInfo>());
  const hoverTimer = useRef<number | null>(null);

  // ---- boot ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    void api.bootstrap().then((boot) => {
      if (cancelled) return;
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
        onPixels: (pixels) => {
          handle.current?.overlay.add(pixels);
          // Keep the template's notion of the canvas current from the same
          // stream, so its progress counter tracks other people's paints as
          // well as your own without re-reading the region.
          let touched = false;
          for (const [x, y, c] of pixels) {
            if (handle.current?.template.applyPaint(x, y, c)) touched = true;
          }
          if (touched) useStore.setState((s) => ({ templateTick: s.templateTick + 1 }));
        },
        onPulse: (pps, recent) =>
          // Keep a short rolling tail rather than replacing: the server sends
          // only what happened in the last second, so on a quiet canvas the
          // ticker would flick empty between paints.
          useStore.setState((s) => ({
            pps,
            recentFlags: [...s.recentFlags, ...recent].slice(-10),
          })),
        // A reconnecting client missed every paint made while it was gone.
        // Those live in the tile PNGs, not the stream, so refetching tiles is
        // what heals the gap — replaying the stream is not possible.
        onReconnect: () => handle.current?.refreshTiles(),
      });
      client.connect();
      ws.current = client;
    });

    return () => {
      cancelled = true;
      // Handlers above close over this render's `handle`/store setters; an
      // un-disconnected socket would keep calling them after unmount (see
      // ws.ts's disconnect() doc — EmbedApp.tsx hit exactly this).
      ws.current?.disconnect();
      ws.current = null;
    };
  }, [hydrate, setBank, setLeaderboard]);

  // ---- hover: fetch the pixel for the inspector and the paint-cost guess ----
  // Terrain is server-side only (the geo index is 38 MB), so neither can be
  // computed client-side without asking. Debounced and cached, this is one
  // small request per hover-settle.
  const onHover = useCallback((pixel: { x: number; y: number } | null) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    useStore.setState({ hoverPixel: pixel });
    if (!pixel) {
      setHoverInfo(null);
      return;
    }

    const k = pixel.x * 1_048_576 + pixel.y;
    const cached = pixelCache.current.get(k);
    if (cached) {
      setHoverInfo(cached);
      return;
    }

    hoverTimer.current = window.setTimeout(() => {
      void api.pixel(pixel.x, pixel.y).then((info) => {
        if (pixelCache.current.size > 2000) pixelCache.current.clear();
        pixelCache.current.set(k, info);
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
    void api.pixel(pixel.x, pixel.y).then((info) => {
      pixelCache.current.set(pixel.x * 1_048_576 + pixel.y, info);
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
    const k = x * 1_048_576 + y;

    // Best guess at the cost so the bank does not visibly jump when the
    // response lands. Falls back to 1 for a pixel we have not inspected.
    const known = pixelCache.current.get(k);
    const guess = known ? costOf(known).cost : 1;

    if (bank < guess) {
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
          handle.current?.overlay.remove(x, y);
          showToast(e instanceof Error ? e.message : "Verification failed.");
          void api.bootstrap().then(hydrate);
          return;
        }
      }
    }

    if (!("ok" in res) || res.ok !== true) {
      const err = res as PaintError;
      handle.current?.overlay.remove(x, y);
      showToast(err.message ?? "Could not paint that pixel.");
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
        h.flyTo(t.x + Math.floor(t.w / 2), t.y + Math.floor(t.h / 2), 14);
        useStore.setState({ sharedTemplateId: t.id });
        return api.region({ x0: t.x, y0: t.y, x1: t.x + t.w - 1, y1: t.y + t.h - 1 });
      })
      .then((r) => {
        if (r) h.template.setActual(Uint8Array.from(atob(r.data), (ch) => ch.charCodeAt(0)));
      })
      .catch(() => showToast("That template link is no longer available."));
  }, []);

  if (!ready) return <div className="wc-boot">Loading the canvas…</div>;

  const toggle = (
    p: "leaderboard" | "settings" | "overlay" | "timelapse" | "report" | "embed" | "account",
  ) => setPanel(panel === p ? "none" : p);

  return (
    <div className="wc-app">
      <MapCanvas
        onPaint={onPaint}
        onHover={onHover}
        onInspect={onInspect}
        onReady={onReady}
        onViewport={onViewport}
      />

      <div className="wc-topbar">
        <ActivityFeed />
        <ChargeBar />
      </div>

      <nav className="wc-rail wc-card" aria-label="Panels">
        <span className="wc-rail-brand">
          <MapPinned size={18} />
        </span>
        <button
          className="wc-rail-btn"
          aria-pressed={panel === "leaderboard"}
          aria-label="Leaderboard"
          title="Leaderboard"
          onClick={() => toggle("leaderboard")}
        >
          <Trophy size={19} />
        </button>
        <button
          className="wc-rail-btn"
          aria-pressed={panel === "overlay"}
          aria-label="Template overlay"
          title="Template overlay"
          onClick={() => toggle("overlay")}
        >
          <LayoutTemplate size={19} />
        </button>
        <button
          className="wc-rail-btn"
          aria-pressed={panel === "timelapse"}
          aria-label="Timelapse"
          title="Timelapse"
          onClick={() => toggle("timelapse")}
        >
          <Clapperboard size={19} />
        </button>
        <button
          className="wc-rail-btn"
          aria-pressed={panel === "report"}
          aria-label="Report an area"
          title="Report an area"
          onClick={() => toggle("report")}
        >
          <Flag size={19} />
        </button>
        <button
          className="wc-rail-btn"
          aria-pressed={panel === "embed"}
          aria-label="Embed"
          title="Embed on your site"
          onClick={() => toggle("embed")}
        >
          <Code2 size={19} />
        </button>
        <span className="wc-rail-spacer" />
        <button
          className="wc-rail-btn"
          aria-pressed={panel === "account"}
          aria-label="Account"
          title={user ? user.displayName : "Sign in"}
          onClick={() => toggle("account")}
        >
          <UserCircle size={19} />
        </button>
        <button
          className="wc-rail-btn"
          aria-pressed={panel === "settings" || panel === "admin"}
          aria-label="Settings"
          title="Settings"
          onClick={() => toggle("settings")}
        >
          <SettingsIcon size={19} />
        </button>
      </nav>

      {panel === "leaderboard" && <LeaderboardPanel />}
      {panel === "overlay" && <OverlayTool handle={handle.current} />}
      {panel === "timelapse" && <TimelapsePanel handle={handle.current} />}
      {panel === "report" && <ReportTool handle={handle.current} />}
      {panel === "embed" && <EmbedTool handle={handle.current} />}

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
        panel === "account") && (
        <div
          className={mapPicking ? "wc-modal-backdrop wc-hidden" : "wc-modal-backdrop"}
          onClick={() => setPanel("none")}
        >
          <div className="wc-modal wc-card" onClick={(e) => e.stopPropagation()}>
            <button className="wc-modal-close" aria-label="Close" onClick={() => setPanel("none")}>
              <X size={18} />
            </button>
            {panel === "settings" && <SettingsPanel />}
            {panel === "status" && <StatusPanel />}
            {panel === "account" && <AccountPanel />}
            {panel === "admin" && <AdminPanel handle={handle.current} />}
            {panel === "country" && openCountry && (
              <CountryPage
                iso={openCountry}
                onFlyTo={(x, y) => handle.current?.flyTo(x, y)}
              />
            )}
          </div>
        </div>
      )}

      {mapPicking && (
        <div className="wc-picking wc-card" role="status">
          <Square size={15} />
          Drag a rectangle on the map
          <em className="wc-hint">Esc to cancel</em>
        </div>
      )}

      {toast && (
        <div key={toast.id} className="wc-toast wc-card" role="status" onAnimationEnd={() => setToast(null)}>
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
