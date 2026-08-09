/**
 * Cloudflare Turnstile — anti-bot layer 1.
 *
 * The server challenges a session's *first* paint with 428 and a sitekey.
 * Until this existed the client simply showed the error, so the layer was
 * unreachable from the browser and did nothing at all: a real user was
 * blocked from their first pixel and a scripted client was not.
 *
 * The script is loaded on demand, not at boot. Turnstile is off in
 * development (blank sitekey), and pulling a third-party script into every
 * page load to support a challenge most sessions never see is the wrong
 * trade.
 */

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      theme?: string;
    },
  ) => string;
  remove: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      loading = null;
      reject(new Error("Could not load the verification widget."));
    };
    document.head.appendChild(el);
  });
  return loading;
}

/**
 * Show the challenge and resolve with a token.
 *
 * Rejects rather than resolving null on failure, so the caller cannot
 * accidentally retry the paint with an empty token and get a second 428 that
 * looks like a different problem.
 */
export async function solveTurnstile(sitekey: string): Promise<string> {
  await loadScript();
  const api = window.turnstile;
  if (!api) throw new Error("Verification is unavailable.");

  const backdrop = document.createElement("div");
  backdrop.className = "wc-turnstile-backdrop";
  const box = document.createElement("div");
  box.className = "wc-turnstile wc-card";
  const label = document.createElement("p");
  label.textContent = "Quick check before your first pixel";
  const host = document.createElement("div");
  box.append(label, host);
  backdrop.append(box);
  document.body.append(backdrop);

  let widgetId: string | undefined;
  const cleanup = () => {
    if (widgetId !== undefined) {
      try {
        api.remove(widgetId);
      } catch {
        /* already gone */
      }
    }
    backdrop.remove();
  };

  return new Promise<string>((resolve, reject) => {
    try {
      widgetId = api.render(host, {
        sitekey,
        theme: "light",
        callback: (token) => {
          cleanup();
          resolve(token);
        },
        "error-callback": () => {
          cleanup();
          reject(new Error("Verification failed. Please try again."));
        },
        "expired-callback": () => {
          cleanup();
          reject(new Error("Verification expired. Please try again."));
        },
      });
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error("Verification failed."));
    }
  });
}
