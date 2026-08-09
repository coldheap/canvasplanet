/**
 * WebSocket fan-out.
 *
 * Two audiences, deliberately separated:
 *   - Pixel frames go only to sockets subscribed to that SUB_ZOOM tile. This
 *     is what stops bandwidth being O(clients x paints) worldwide.
 *   - Leaderboard, pulse and freeze frames go to everyone, on a 1 Hz tick.
 *     The climbing number is the point of the app, so it is never filtered.
 *
 * Single-instance by design. If this ever needs to scale out, this file and
 * tiles/cache.ts are the only two that change (Redis pub/sub goes here).
 */

import {
  LB_TICK_MS,
  PX_BATCH_MS,
  SUB_ZOOM,
  WS_BACKPRESSURE_BYTES,
  type PixelTuple,
  type ServerMessage,
  tileKeyAt,
} from "@worldcanvas/shared";
import type { WebSocket } from "ws";

interface Conn {
  socket: WebSocket;
  /**
   * Null for an anonymous read-only connection (embeds — see index.ts's
   * `?ro=1`). Those never receive a personal `charges` push and are not
   * tracked in `bySession`, but still get every broadcast: pixel frames,
   * leaderboard and pulse are public data regardless of who is watching.
   */
  sessionId: number | null;
  /** Embeds receive canvas broadcasts but never the app's chat stream. */
  receivesChat: boolean;
  tiles: Set<string>;
  /** Set when backpressure forced us to drop frames; the client is told to
   *  refetch its tiles rather than being left with a hole in the canvas. */
  degraded: boolean;
}

/** Merge the per-second country buckets into the ranked rolling-window view. */
export function rankActiveCountries(
  windows: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  limit = 8,
): Array<[number, number]> {
  const totals = new Map<number, number>();
  for (const countries of windows) {
    for (const [countryId, count] of countries) {
      totals.set(countryId, (totals.get(countryId) ?? 0) + count);
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

class Hub {
  private conns = new Set<Conn>();
  private byTile = new Map<string, Set<Conn>>();
  private bySession = new Map<number, Set<Conn>>();

  /** Pixels accumulated since the last flush, grouped by subscription tile. */
  private pending = new Map<string, PixelTuple[]>();
  private pxTimer: NodeJS.Timeout | null = null;
  private lbTimer: NodeJS.Timeout | null = null;

  /** Rolling window for the paints-per-second readout. */
  private recentPaints: number[] = [];
  private recentCountries: number[] = [];
  private pulseHistory: number[] = [];
  private countryHistory: Array<Array<[number, number]>> = [];

  /** One or more tick sources, each polled every LB_TICK_MS — the country
   *  and alliance leaderboards are two independent dirty flags, so each
   *  gets its own quiet-canvas-costs-nothing check rather than forcing them
   *  onto one combined message. */
  start(onTicks: Array<() => ServerMessage | null>): void {
    this.pxTimer = setInterval(() => this.flushPixels(), PX_BATCH_MS);
    this.lbTimer = setInterval(() => {
      for (const onTick of onTicks) {
        const msg = onTick();
        if (msg) this.broadcast(msg);
      }
      const pps = this.recentPaints.length;
      this.pulseHistory = [...this.pulseHistory, pps].slice(-60);
      const currentCountryCounts = new Map<number, number>();
      for (const countryId of this.recentCountries) {
        currentCountryCounts.set(countryId, (currentCountryCounts.get(countryId) ?? 0) + 1);
      }
      this.countryHistory = [...this.countryHistory, [...currentCountryCounts.entries()]].slice(-60);

      this.broadcast({
        t: "pulse",
        pps,
        history: this.pulseHistory,
        recent: this.recentCountries.slice(-12),
        active: rankActiveCountries(this.countryHistory),
      });
      this.recentPaints = [];
      this.recentCountries = [];
    }, LB_TICK_MS);
  }

  stop(): void {
    if (this.pxTimer) clearInterval(this.pxTimer);
    if (this.lbTimer) clearInterval(this.lbTimer);
  }

  add(socket: WebSocket, sessionId: number | null, receivesChat = true): Conn {
    const conn: Conn = { socket, sessionId, receivesChat, tiles: new Set(), degraded: false };
    this.conns.add(conn);
    if (sessionId !== null) {
      let set = this.bySession.get(sessionId);
      if (!set) this.bySession.set(sessionId, (set = new Set()));
      set.add(conn);
    }
    return conn;
  }

  remove(conn: Conn): void {
    this.conns.delete(conn);
    for (const key of conn.tiles) this.byTile.get(key)?.delete(conn);
    if (conn.sessionId === null) return;
    const set = this.bySession.get(conn.sessionId);
    set?.delete(conn);
    if (set && set.size === 0) this.bySession.delete(conn.sessionId);
  }

  /** Replaces the connection's subscription set wholesale. */
  subscribe(conn: Conn, tiles: string[]): void {
    // Cap it: a client claiming 10,000 tiles is either broken or hostile.
    const next = new Set(tiles.slice(0, 64));
    for (const key of conn.tiles) {
      if (!next.has(key)) this.byTile.get(key)?.delete(conn);
    }
    for (const key of next) {
      if (!conn.tiles.has(key)) {
        let set = this.byTile.get(key);
        if (!set) this.byTile.set(key, (set = new Set()));
        set.add(conn);
      }
    }
    conn.tiles = next;
    if (process.env.WC_DEBUG_WS) {
      console.log(`[hub] sub conn(session=${conn.sessionId}) -> [${[...next].join(",")}]`);
    }
  }

  /** Called by the paint route after a successful commit. */
  publishPaint(x: number, y: number, color: number, countryId: number): void {
    const key = tileKeyAt(SUB_ZOOM, x, y);
    let batch = this.pending.get(key);
    if (!batch) this.pending.set(key, (batch = []));
    batch.push([x, y, color]);

    this.recentPaints.push(1);
    this.recentCountries.push(countryId);
  }

  private flushPixels(): void {
    if (this.pending.size === 0) return;
    for (const [key, pixels] of this.pending) {
      const subs = this.byTile.get(key);
      if (process.env.WC_DEBUG_WS) {
        console.log(
          `[hub] flush ${key}: ${pixels.length}px -> ${subs?.size ?? 0} subs; known keys=[${[...this.byTile.keys()].join(",")}]`,
        );
      }
      if (!subs || subs.size === 0) continue;
      const frame = JSON.stringify({ t: "px", p: pixels } satisfies ServerMessage);
      for (const conn of subs) this.sendRaw(conn, frame, /* droppable */ true);
    }
    this.pending.clear();
  }

  broadcast(msg: ServerMessage): void {
    const frame = JSON.stringify(msg);
    for (const conn of this.conns) this.sendRaw(conn, frame, false);
  }

  /** Global chat reaches the full app, including logged-out viewers, but not
   * read-only embed sockets that have no chat UI. */
  broadcastChat(msg: Extract<ServerMessage, { t: "chat" | "chat_update" }>): void {
    const frame = JSON.stringify(msg);
    for (const conn of this.conns) {
      if (conn.receivesChat) this.sendRaw(conn, frame, false);
    }
  }

  /** Charge updates go to every tab of one session, and nowhere else. */
  sendToSession(sessionId: number, msg: ServerMessage): void {
    const set = this.bySession.get(sessionId);
    if (!set) return;
    const frame = JSON.stringify(msg);
    for (const conn of set) this.sendRaw(conn, frame, false);
  }

  /**
   * A slow client degrades to "tiles only" — it stops receiving pixel frames
   * but never stops receiving the leaderboard, and it never stalls the hub.
   */
  private sendRaw(conn: Conn, frame: string, droppable: boolean): void {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    if (droppable && conn.socket.bufferedAmount > WS_BACKPRESSURE_BYTES) {
      conn.degraded = true;
      return;
    }
    conn.socket.send(frame);
  }

  stats() {
    return {
      clients: this.conns.size,
      tiles: this.byTile.size,
      degraded: [...this.conns].filter((c) => c.degraded).length,
    };
  }
}

export const hub = new Hub();
export type { Conn };
