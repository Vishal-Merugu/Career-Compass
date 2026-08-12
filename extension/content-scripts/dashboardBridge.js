// ─── Dashboard Bridge ────────────────────────────────────────────
//
// Lets the web dashboard see this extension and poke it.
//
// The queue drains on a one-minute alarm whether or not this exists, so nothing
// here is required for correctness. What it fixes is the dashboard having no
// way to tell "no browser has claimed these yet" from "there is no extension in
// this browser at all" — both rendered as "waiting for Chrome", and only one of
// them is something the user can act on.
//
// A content script rather than `externally_connectable`: that needs the page to
// know the extension id, which is not stable for an unpacked install, so every
// developer machine would need its own build. The bridge is injected by the
// extension itself, so the page needs to know nothing.
//
// **Only two actions are relayed, by allowlist.** The page is same-origin with
// the backend but it is still page script, and the message channel it is
// talking to also serves `getStatus`, which returns the config — including the
// long-lived API key. An open relay here would publish that key to anything
// running on the dashboard origin.

const RELAYED = new Set(['bridge:ping', 'bridge:drain']);

window.addEventListener('message', (event) => {
  // Same-frame only. `event.source` is the one check that cannot be forged by
  // an iframe or another window posting in.
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.__cc !== 'req' || typeof data.id !== 'string') return;
  if (!RELAYED.has(data.action)) return;

  chrome.runtime.sendMessage({ action: data.action }, (response) => {
    // A dead worker that failed to wake, or an extension being reloaded. The
    // page is waiting on a reply either way, so answer rather than letting its
    // timeout decide — a silent drop reads as "not installed", which is the
    // one thing we are here to disprove.
    const payload = chrome.runtime.lastError
      ? { ok: false, error: chrome.runtime.lastError.message }
      : response;

    window.postMessage({ __cc: 'res', id: data.id, payload }, window.origin);
  });
});

// Announce on load as well as on demand. The page may have finished its own
// ping before this script was injected — `document_start` beats page script in
// practice, but not by contract.
window.postMessage({ __cc: 'hello' }, window.origin);
