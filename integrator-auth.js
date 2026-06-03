// Byzantine Integrator API — interactive playground signing helper.
//
// Mintlify's playground routes every Send through a same-origin proxy POST
// to /_mintlify/api/request carrying a JSON envelope describing the target
// request. We intercept that XHR, parse the envelope, sign any request
// that targets sandbox.api.byzantine.fi, inject X-Pubkey / X-Timestamp /
// X-Signature into envelope.header, and forward. All HTTP methods, query
// params, and JSON bodies (flat or nested) are supported.
//
// Async-in-sync resolution: crypto.subtle.sign is async, XHR.send is sync.
// We defer the actual send until signing completes — the XHR's
// onreadystatechange handlers stay wired to the same instance.

(function () {
  "use strict";

  // ── Constants ───────────────────────────────────────────────────────────
  const SESSION_KEY  = "byz_sandbox_auth";
  const SESSION_TTL  = 30 * 60 * 1000;
  const IDB_NAME     = "byzantine-docs-auth";
  const IDB_STORE    = "keys";
  const IDB_VERSION  = 1;
  const MOUNT_ID     = "byz-auth-mount";
  const BADGE_ID     = "byz-badge";
  const SANDBOX_HOST = "sandbox.api.byzantine.fi";
  const PROXY_PATH   = "/_mintlify/api/request";
  const SANDBOX_AUTH_PATH = "/api-reference/sandbox-auth";

  // 35-byte PKCS#8 DER prefix for a P-256 EC private key. Concatenated with
  // a 32-byte scalar produces a valid PKCS#8 that Web Crypto's importKey
  // accepts — the public point is derived by the browser, so no EC math
  // runs in JavaScript.
  const PKCS8_PREFIX = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
    0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
    0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
  ]);

  const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" };

  console.log("[Byzantine Auth] integrator-auth.js loaded —", location.pathname);

  // ── IndexedDB helpers ───────────────────────────────────────────────────
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked — close other tabs and try again."));
    });
  }

  async function idbPut(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror    = (e) => { db.close(); reject(e.target.error); };
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = (e) => { db.close(); resolve(e.target.result ?? null); };
      req.onerror   = (e) => { db.close(); reject(e.target.error); };
    });
  }

  async function idbDelete(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror    = (e) => { db.close(); reject(e.target.error); };
    });
  }

  // ── Session (metadata only — no key material) ──────────────────────────
  function getSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      if (!s) return null;
      if (Date.now() > s.expiresAt) {
        if (s.keyId) idbDelete(s.keyId).catch(() => {});
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }
      return s;
    } catch { return null; }
  }

  function saveSession(keyId, pubkey) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      keyId, pubkey, expiresAt: Date.now() + SESSION_TTL,
    }));
  }

  function clearSession() {
    const s = getSession();
    if (s && s.keyId) idbDelete(s.keyId).catch(() => {});
    sessionStorage.removeItem(SESSION_KEY);
  }

  // ── Crypto helpers ──────────────────────────────────────────────────────
  function hexToBytes(hex) {
    const c = hex.replace(/^0x/i, "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(c)) {
      throw new Error("Private key must be exactly 32 bytes (64 hex characters).");
    }
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++) b[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
    return b;
  }

  function bytesToHex(b) {
    return Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
  }

  function base64urlToBytes(b64) {
    const std = b64.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(std);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // IEEE P1363 (r‖s, 64 bytes) → DER. Web Crypto returns P1363; the
  // Byzantine API expects DER.
  function p1363ToDer(buf) {
    let r = buf.slice(0, 32);
    let s = buf.slice(32, 64);
    let ri = 0; while (ri < 31 && r[ri] === 0) ri++;
    let si = 0; while (si < 31 && s[si] === 0) si++;
    r = r.slice(ri);
    s = s.slice(si);
    if (r[0] & 0x80) r = new Uint8Array([0, ...r]);
    if (s[0] & 0x80) s = new Uint8Array([0, ...s]);
    const body = new Uint8Array(2 + r.length + 2 + s.length);
    let i = 0;
    body[i++] = 0x02; body[i++] = r.length; body.set(r, i); i += r.length;
    body[i++] = 0x02; body[i++] = s.length; body.set(s, i);
    const der = new Uint8Array(2 + body.length);
    der[0] = 0x30; der[1] = body.length; der.set(body, 2);
    return der;
  }

  // ── Key import ─────────────────────────────────────────────────────────
  async function importAndStoreKey(privBytes) {
    const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
    pkcs8.set(PKCS8_PREFIX);
    pkcs8.set(privBytes, PKCS8_PREFIX.length);

    const tempKey = await crypto.subtle.importKey("pkcs8", pkcs8.buffer, ECDSA_P256, true, ["sign"]);
    const jwk     = await crypto.subtle.exportKey("jwk", tempKey);
    const xBytes  = base64urlToBytes(jwk.x);
    const yBytes  = base64urlToBytes(jwk.y);
    try { delete jwk.d; } catch {}

    const pubBytes = new Uint8Array(33);
    pubBytes[0] = (yBytes[31] & 1) ? 0x03 : 0x02;
    pubBytes.set(xBytes, 1);
    const pubkey = "0x" + bytesToHex(pubBytes);

    const signingKey = await crypto.subtle.importKey("pkcs8", pkcs8.buffer, ECDSA_P256, false, ["sign"]);

    pkcs8.fill(0);
    privBytes.fill(0);

    const keyId = crypto.randomUUID();
    await idbPut(keyId, signingKey);
    return { keyId, pubkey };
  }

  // ── Signed-header computation ──────────────────────────────────────────
  async function computeHeaders(method, pathAndQuery, bodyStr) {
    const session = getSession();
    if (!session) return null;
    const signingKey = await idbGet(session.keyId);
    if (!signingKey) return null;

    const ts  = Math.floor(Date.now() / 1000).toString();
    const msg = new TextEncoder().encode(ts + method.toUpperCase() + pathAndQuery + (bodyStr || ""));
    const raw = await crypto.subtle.sign({ name: "ECDSA", hash: { name: "SHA-256" } }, signingKey, msg);

    return {
      "X-Pubkey":    session.pubkey,
      "X-Timestamp": ts,
      "X-Signature": "0x" + bytesToHex(p1363ToDer(new Uint8Array(raw))),
    };
  }

  // ── XHR interception ───────────────────────────────────────────────────
  // We patch open() to capture the URL (needed in send), and send() to
  // detect the Mintlify proxy POST and defer-sign sandbox-bound requests.
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__byzUrl = url;
    return _xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__byzUrl === PROXY_PATH && typeof body === "string") {
      deferredSignAndSend(this, body);
      return;
    }
    return _xhrSend.call(this, body);
  };

  // Any HTTP method is in scope. The signing string is
  // {ts}{METHOD}{pathAndQuery}{bodyStr}.
  function inScope(env) {
    return typeof env.method === "string";
  }

  // Build the path+query string used in the signed message. Mintlify's
  // proxy is presumed to serialize env.query via the standard
  // URLSearchParams behavior — same as us — so signatures match.
  function pathAndQueryFor(targetUrl, query) {
    if (!query || Object.keys(query).length === 0) return targetUrl.pathname;
    return targetUrl.pathname + "?" + new URLSearchParams(query).toString();
  }

  // Build the body string used in the signed message. If env.body is
  // absent, sign over "" (no body sent). If present (even as empty
  // object), JSON.stringify with default no-spacing serialization —
  // assumed to match what Mintlify's proxy forwards to sandbox.
  function bodyStringFor(body) {
    return body != null ? JSON.stringify(body) : "";
  }

  function deferredSignAndSend(xhr, originalBody) {
    (async () => {
      try {
        let env;
        try { env = JSON.parse(originalBody); }
        catch { return _xhrSend.call(xhr, originalBody); }

        let targetUrl;
        try { targetUrl = new URL(env.url); }
        catch { return _xhrSend.call(xhr, originalBody); }

        if (targetUrl.hostname !== SANDBOX_HOST) {
          return _xhrSend.call(xhr, originalBody);
        }

        if (!inScope(env)) {
          console.log(
            "[Byzantine Auth] Out of scope — passing through unsigned:",
            env.method, targetUrl.pathname
          );
          return _xhrSend.call(xhr, originalBody);
        }

        const pathAndQuery = pathAndQueryFor(targetUrl, env.query);
        const bodyStr      = bodyStringFor(env.body);
        const auth = await computeHeaders(env.method, pathAndQuery, bodyStr);
        if (!auth) {
          console.log("[Byzantine Auth] No active session — request goes unsigned to:", pathAndQuery);
          return _xhrSend.call(xhr, originalBody);
        }

        env.header = { ...(env.header || {}), ...auth };
        console.log(
          "[Byzantine Auth] Signed",
          env.method.toUpperCase(), pathAndQuery,
          "body bytes:", bodyStr.length,
          "ts:", auth["X-Timestamp"]
        );
        return _xhrSend.call(xhr, JSON.stringify(env));
      } catch (e) {
        console.error("[Byzantine Auth] Signing path threw:", e);
        return _xhrSend.call(xhr, originalBody);
      }
    })();
  }

  // ── UI ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("byz-auth-styles")) return;
    const s = document.createElement("style");
    s.id = "byz-auth-styles";
    s.textContent = `
      #${MOUNT_ID} * { box-sizing: border-box; }
      #${MOUNT_ID} {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px; color: #111827;
        margin: 18px 0;
      }
      .byz-field { margin-bottom: 12px; }
      .byz-label {
        display: block; font-size: 12px; font-weight: 500;
        color: #374151; margin-bottom: 5px;
      }
      .byz-label span { font-weight: 400; color: #9ca3af; }
      .byz-input {
        width: 100%; padding: 8px 11px; border: 1px solid #d1d5db;
        border-radius: 6px; font-size: 13px;
        font-family: Monaco, Menlo, monospace;
        background: #fff; color: #111827;
        transition: border-color .15s, box-shadow .15s;
      }
      .byz-input:focus {
        outline: none; border-color: #702963;
        box-shadow: 0 0 0 3px rgba(112,41,99,.12);
      }
      .byz-btn {
        width: 100%; padding: 9px 16px;
        background: #702963; color: #fff; border: none;
        border-radius: 6px; font-size: 13px; font-weight: 500;
        cursor: pointer; transition: background .15s;
      }
      .byz-btn:hover:not(:disabled) { background: #5c1f51; }
      .byz-btn:disabled { background: #9ca3af; cursor: not-allowed; }
      .byz-error {
        margin-top: 10px; padding: 8px 12px;
        background: #fef2f2; border: 1px solid #fecaca;
        border-radius: 6px; font-size: 12px; color: #b91c1c;
      }
      .byz-card { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
      .byz-card-head {
        display: flex; align-items: center; gap: 9px;
        padding: 12px 14px;
        background: #f0fdf4; border-bottom: 1px solid #bbf7d0;
      }
      .byz-dot {
        width: 9px; height: 9px; border-radius: 50%;
        background: #16a34a; flex-shrink: 0;
        box-shadow: 0 0 0 3px rgba(22,163,74,.2);
      }
      .byz-title { font-size: 13px; font-weight: 600; color: #15803d; }
      .byz-countdown {
        margin-left: auto; font-size: 11px; color: #6b7280;
        font-variant-numeric: tabular-nums;
      }
      .byz-countdown.urgent { color: #f59e0b; font-weight: 500; }
      .byz-card-body { padding: 12px 14px; }
      .byz-row { margin-bottom: 10px; }
      .byz-row:last-child { margin-bottom: 0; }
      .byz-row-label {
        font-size: 11px; font-weight: 500; color: #6b7280; margin-bottom: 3px;
        font-family: Monaco, Menlo, monospace;
      }
      .byz-row-val {
        font-family: Monaco, Menlo, monospace; font-size: 11px;
        color: #111827; word-break: break-all; line-height: 1.5;
        background: #f9fafb; padding: 5px 8px; border-radius: 4px;
        border: 1px solid #f3f4f6;
      }
      .byz-card-foot {
        padding: 10px 14px; border-top: 1px solid #f3f4f6;
        display: flex; justify-content: flex-end;
      }
      .byz-deactivate {
        padding: 5px 14px; font-size: 12px;
        background: transparent; border: 1px solid #fca5a5;
        border-radius: 5px; color: #b91c1c; cursor: pointer;
        transition: background .1s;
      }
      .byz-deactivate:hover { background: #fef2f2; }
    `;
    document.head.appendChild(s);
  }

  let countdownTimer = null;

  function renderSetupForm(mount) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    mount.innerHTML = `
      <form id="byz-form">
        <div class="byz-field">
          <label class="byz-label">
            Sandbox Integrator Private Key
            <span>— hex, with or without 0x prefix</span>
          </label>
          <input
            id="byz-pk-input"
            class="byz-input"
            type="password"
            placeholder="0x…"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <button id="byz-submit" class="byz-btn" type="submit">Activate Sandbox authentication</button>
      </form>
      <div id="byz-form-error" class="byz-error" style="display:none"></div>
    `;

    document.getElementById("byz-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("byz-form-error");
      const btn   = document.getElementById("byz-submit");
      const input = document.getElementById("byz-pk-input");
      errEl.style.display = "none";
      btn.disabled = true;
      btn.textContent = "Activating…";

      try {
        const privBytes = hexToBytes(input.value);
        const { keyId, pubkey } = await importAndStoreKey(privBytes);
        input.value = "";
        saveSession(keyId, pubkey);
        mount.dataset.byzRendered = "";
        refreshMount();
      } catch (err) {
        errEl.textContent   = err.message || String(err);
        errEl.style.display = "block";
        btn.disabled = false;
        btn.textContent = "Activate Sandbox authentication";
      }
    });
  }

  function renderActiveCard(mount, session) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    mount.innerHTML = `
      <div class="byz-card">
        <div class="byz-card-head">
          <span class="byz-dot"></span>
          <span class="byz-title">Sandbox authentication active</span>
          <span class="byz-countdown" id="byz-countdown"></span>
        </div>
        <div class="byz-card-body">
          <div class="byz-row">
            <div class="byz-row-label">X-Pubkey (derived from your key)</div>
            <div class="byz-row-val">${session.pubkey}</div>
          </div>
          <div class="byz-row">
            <div class="byz-row-label">Active signing scope</div>
            <div class="byz-row-val" style="color:#6b7280">
              All requests to sandbox.api.byzantine.fi are signed automatically — every method, query, and body shape.
            </div>
          </div>
        </div>
        <div class="byz-card-foot">
          <button class="byz-deactivate" id="byz-deactivate">Deactivate session</button>
        </div>
      </div>
    `;

    function tick() {
      const el = document.getElementById("byz-countdown");
      if (!el) { clearInterval(countdownTimer); countdownTimer = null; return; }
      const ms = session.expiresAt - Date.now();
      if (ms <= 0) {
        clearInterval(countdownTimer); countdownTimer = null;
        clearSession();
        mount.dataset.byzRendered = "";
        refreshMount();
        return;
      }
      const m = Math.floor(ms / 60_000);
      const sec = Math.floor((ms % 60_000) / 1000);
      el.textContent = `${m}m ${String(sec).padStart(2, "0")}s remaining`;
      el.className = "byz-countdown" + (m < 5 ? " urgent" : "");
    }
    tick();
    countdownTimer = setInterval(tick, 1000);

    document.getElementById("byz-deactivate").addEventListener("click", () => {
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      clearSession();
      mount.dataset.byzRendered = "";
      refreshMount();
    });
  }

  function refreshMount() {
    const mount = document.getElementById(MOUNT_ID);
    if (mount) {
      const session = getSession();
      const desired = session ? "active" : "setup";
      if (mount.dataset.byzRendered !== desired) {
        injectStyles();
        if (session) renderActiveCard(mount, session);
        else          renderSetupForm(mount);
        mount.dataset.byzRendered = desired;
      }
    }
    renderBadge();
  }

  // ── Floating session countdown badge ───────────────────────────────────
  // Fixed bottom-right pill visible on every docs page while a session is
  // active. Click navigates to the sandbox-auth page.
  let badgeTimer = null;

  function ensureBadge() {
    let badge = document.getElementById(BADGE_ID);
    if (badge) return badge;
    badge = document.createElement("a");
    badge.id    = BADGE_ID;
    badge.href  = SANDBOX_AUTH_PATH;
    badge.title = "Sandbox auth active — click to manage";
    Object.assign(badge.style, {
      position:       "fixed",
      bottom:         "20px",
      right:          "20px",
      zIndex:         "99999",
      background:     "#702963",
      color:          "#fff",
      padding:        "8px 14px",
      borderRadius:   "999px",
      fontSize:       "12px",
      fontWeight:     "500",
      fontFamily:     "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif",
      boxShadow:      "0 4px 12px rgba(0,0,0,0.25)",
      cursor:         "pointer",
      textDecoration: "none",
      display:        "flex",
      alignItems:     "center",
      gap:            "8px",
      lineHeight:     "1",
      userSelect:     "none",
    });
    document.body.appendChild(badge);
    return badge;
  }

  function removeBadge() {
    const existing = document.getElementById(BADGE_ID);
    if (existing) existing.remove();
  }

  function tickBadge() {
    const session = getSession();
    if (!session) {
      removeBadge();
      if (badgeTimer) { clearInterval(badgeTimer); badgeTimer = null; }
      return;
    }
    const ms = session.expiresAt - Date.now();
    if (ms <= 0) {
      clearSession();
      removeBadge();
      if (badgeTimer) { clearInterval(badgeTimer); badgeTimer = null; }
      const mount = document.getElementById(MOUNT_ID);
      if (mount) { mount.dataset.byzRendered = ""; refreshMount(); }
      return;
    }
    const m   = Math.floor(ms / 60_000);
    const sec = Math.floor((ms % 60_000) / 1000);
    const urgent = m < 5;
    // Cache rendered state on the element itself (as a JS property, NOT a
    // DOM attribute) so reentrant calls from the MutationObserver don't
    // rewrite innerHTML — which would trigger the observer again and loop.
    const wantedKey = `${m}m ${String(sec).padStart(2, "0")}s|${urgent ? "u" : "n"}`;
    const badge = ensureBadge();
    if (badge.__byzKey === wantedKey) return;
    badge.__byzKey = wantedKey;
    const dotColor  = urgent ? "#fb923c" : "#4ade80";
    const dotShadow = urgent ? "rgba(251,146,60,.3)" : "rgba(74,222,128,.3)";
    badge.innerHTML =
      `<span style="width:8px;height:8px;border-radius:50%;background:${dotColor};box-shadow:0 0 0 2px ${dotShadow};flex-shrink:0;"></span>` +
      `<span>Sandbox auth &middot; ${m}m ${String(sec).padStart(2, "0")}s</span>`;
  }

  function renderBadge() {
    tickBadge();
    if (badgeTimer === null && getSession()) {
      badgeTimer = setInterval(tickBadge, 1000);
    }
  }

  function startObserving() {
    refreshMount();
    new MutationObserver(refreshMount).observe(document.body, {
      childList: true, subtree: true,
    });
  }

  if (document.body) startObserving();
  else document.addEventListener("DOMContentLoaded", startObserving);

  // ── Pagehide cleanup ───────────────────────────────────────────────────
  window.addEventListener("pagehide", () => {
    const s = getSession();
    if (s && s.keyId) idbDelete(s.keyId).catch(() => {});
  });
})();
