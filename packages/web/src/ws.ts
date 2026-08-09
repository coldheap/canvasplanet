/**
 * WebSocket client.
 *
 * Subscribes to the z10 tiles currently in view and re-subscribes on every
 * map move, so the pixel stream is bounded by what is actually on screen
 * rather than by how busy the world is.
 *
 * Reconnects with backoff. On reconnect the client must refetch its visible
 * tiles — anything painted while it was offline is in the PNGs, not in the
 * stream, so the tile layer is what heals the gap.
 */

import {
  SUB_ZOOM,
  type AllianceLbRow,
  type LbRow,
  type PixelTuple,
  type ServerMessage,
  type UserLbRow,
  subKeysForBbox,
} from "@worldcanvas/shared";

type Handlers = {
  onPixels: (pixels: PixelTuple[]) => void;
  onLeaderboard: (world: number, rows: LbRow[]) => void;
  onAllianceLeaderboard: (rows: AllianceLbRow[]) => void;
  onUserLeaderboard: (rows: UserLbRow[]) => void;
  onCharges: (bank: number, nextAt: number | null) => void;
  onPulse: (pps: number, recent: number[]) => void;
  onFreeze: (on: boolean) => void;
  onReconnect: () => void;
};

export class WsClient {
  private socket: WebSocket | null = null;
  private retry = 0;
  private tiles: string[] = [];
  private pingTimer: number | null = null;
  /** Set by disconnect(); stops the reconnect-with-backoff loop from firing
   *  again once the owner has deliberately torn this client down. */
  private closed = false;

  constructor(
    private readonly handlers: Partial<Handlers>,
    /**
     * Skips the session requirement entirely — for the embeddable widget,
     * which runs inside a cross-origin iframe where the session cookie
     * (SameSite=Lax) can never be attached. Read-only: it can still send
     * `sub`, just never anything that mutates state. See index.ts's `?ro=1`.
     */
    private readonly readOnly = false,
  ) {}

  connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = this.readOnly ? "?ro=1" : "";
    const socket = new WebSocket(`${proto}//${location.host}/ws${qs}`);
    this.socket = socket;

    socket.onopen = () => {
      const reconnected = this.retry > 0;
      this.retry = 0;
      if (this.tiles.length) this.send({ t: "sub", tiles: this.tiles });
      // Keeps the connection alive through Cloudflare's idle timeout.
      this.pingTimer = window.setInterval(() => this.send({ t: "ping" }), 30_000);
      if (reconnected) this.handlers.onReconnect?.();
    };

    socket.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.t) {
        case "px":
          this.handlers.onPixels?.(msg.p);
          break;
        case "lb":
          this.handlers.onLeaderboard?.(msg.world, msg.rows);
          break;
        case "alb":
          this.handlers.onAllianceLeaderboard?.(msg.rows);
          break;
        case "plb":
          this.handlers.onUserLeaderboard?.(msg.rows);
          break;
        case "charges":
          this.handlers.onCharges?.(msg.bank, msg.nextAt);
          break;
        case "pulse":
          this.handlers.onPulse?.(msg.pps, msg.recent);
          break;
        case "freeze":
          this.handlers.onFreeze?.(msg.on);
          break;
      }
    };

    socket.onclose = () => {
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      if (this.closed) return;
      // Exponential backoff to 30s, jittered so a server restart does not
      // bring every client back in the same millisecond.
      const delay = Math.min(30_000, 500 * 2 ** this.retry++) * (0.5 + Math.random());
      window.setTimeout(() => this.connect(), delay);
    };
  }

  /**
   * Tears the client down for good: no more reconnect attempts, and every
   * handler stops firing. Callers whose handlers close over something
   * torn down alongside them (a Leaflet map, a canvas overlay) must call
   * this on unmount — an un-disconnected socket keeps delivering messages
   * to handlers that reference objects which no longer exist.
   */
  disconnect(): void {
    this.closed = true;
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.socket?.close();
  }

  /** Called on every map move. Cheap: it diffs before sending. */
  setViewport(bbox: { x0: number; y0: number; x1: number; y1: number }, zoom: number): void {
    const tiles = zoom >= SUB_ZOOM ? subKeysForBbox(bbox, SUB_ZOOM) : [];
    if (tiles.length === this.tiles.length && tiles.every((t, i) => t === this.tiles[i])) return;
    this.tiles = tiles;
    this.send({ t: "sub", tiles });
  }

  private send(msg: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}
