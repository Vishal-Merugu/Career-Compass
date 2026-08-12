/**
 * Is the CareerCompass extension in this browser, and can we poke it?
 *
 * The email-lookup queue drains on the extension's own one-minute alarm and
 * needs nothing from here. What this adds is the two things an alarm cannot
 * give the dashboard:
 *
 *   * **An answer.** A queued row that no browser has claimed and a browser
 *     that does not exist looked identical on Results — both "waiting for
 *     Chrome" — and only one of them is the user's to fix.
 *   * **A nudge.** Messaging the extension wakes its suspended service worker,
 *     so pressing "Find emails" can start the drain now instead of at the next
 *     tick.
 *
 * The channel is `window.postMessage` to a content script the extension injects
 * on this origin (`extension/content-scripts/dashboardBridge.js`); the page
 * needs no extension id, which is what makes this work for an unpacked install.
 * No reply means no extension — there is nothing else on the other end.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** A ping that goes unanswered this long is treated as "nothing there". */
const PING_TIMEOUT_MS = 1_500;

type BridgeAction = 'bridge:ping' | 'bridge:drain';

interface BridgeResponse {
  ok: boolean;
  version?: string;
  linked?: boolean;
  backendUrl?: string | null;
  error?: string;
  processed?: number;
}

interface BridgeFrame {
  __cc?: string;
  id?: string;
  payload?: BridgeResponse;
}

/**
 * `unknown` until the first ping resolves, because the honest thing to render
 * before then is nothing — a dashboard that flashes "extension not detected"
 * on every load and corrects itself 200ms later teaches the user to ignore it.
 */
export type ExtensionState = 'unknown' | 'absent' | 'unlinked' | 'ready';

function call(action: BridgeAction): Promise<BridgeResponse | null> {
  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (value: BridgeResponse | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(value);
    };

    const onMessage = (event: MessageEvent<BridgeFrame>) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__cc !== 'res' || data.id !== id) return;
      finish(data.payload ?? null);
    };

    const timer = setTimeout(() => finish(null), PING_TIMEOUT_MS);

    window.addEventListener('message', onMessage);
    window.postMessage({ __cc: 'req', id, action }, window.origin);
  });
}

export function useExtensionBridge() {
  const [state, setState] = useState<ExtensionState>('unknown');
  const [version, setVersion] = useState<string | null>(null);

  const ping = useCallback(async () => {
    const res = await call('bridge:ping');
    if (!res?.ok) {
      setState('absent');
      setVersion(null);
      return;
    }
    setVersion(res.version ?? null);
    setState(res.linked ? 'ready' : 'unlinked');
  }, []);

  useEffect(() => {
    void ping();

    // The extension can be installed, linked or reloaded while this tab sits
    // open, and its `hello` on injection covers only the first of those.
    const onHello = (event: MessageEvent<BridgeFrame>) => {
      if (event.source === window && event.data?.__cc === 'hello') void ping();
    };
    window.addEventListener('message', onHello);

    // Slow, because this is a status line rather than progress: a poll fast
    // enough to feel live would post a message every few seconds forever, and
    // each one wakes the extension's service worker.
    const timer = setInterval(() => void ping(), 30_000);

    return () => {
      window.removeEventListener('message', onHello);
      clearInterval(timer);
    };
  }, [ping]);

  const draining = useRef(false);

  /**
   * Ask the extension to drain now. Safe to call speculatively — the drainer
   * ignores a second request while one is in flight, and an absent extension
   * simply times out.
   */
  const drainNow = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      const res = await call('bridge:drain');
      // A drain request is also a liveness probe, and a cheaper one than the
      // poll: if it answered, the extension is here.
      if (res?.ok) setState((prev) => (prev === 'absent' ? 'ready' : prev));
      else if (res === null) setState('absent');
    } finally {
      draining.current = false;
    }
  }, []);

  return { state, version, ping, drainNow };
}
