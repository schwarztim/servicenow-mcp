/**
 * Clean auth module following sun-demo DIRECT pipeline.
 * Headless-only. Credentials from macOS Keychain via `security` CLI.
 * Exports getAuthHeaders() — lazy, cached, no Bearer tokens.
 */

import { firefox } from "playwright";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE_FILE = join(PROJECT_DIR, ".cookie-cache.json");
// Volume-mounted cookie file from host-auth.mjs (host captures SSO cookies, container reads them)
const MOUNTED_COOKIE_FILE = process.env.SERVICENOW_COOKIE_FILE || "/root/.servicenow-mcp/cookies.json";
const CACHE_TTL = 8 * 60 * 60 * 1000; // 8 hours
const TARGET_URL = process.env.SERVICENOW_INSTANCE_URL || "https://instance.service-now.com";
const TARGET_HOST = new URL(TARGET_URL).hostname;

const EMAIL_SELECTORS = [
  'input[name="loginfmt"]', 'input[type="email"]', 'input[name="email"]',
  'input[name="username"]', 'input[name="user"]', 'input[name="login"]',
  'input#username', 'input#email',
];
const PW_SELECTORS = [
  'input[name="passwd"]', 'input[type="password"]', 'input[name="password"]',
];
const CONSENT_SELECTORS = [
  '#idSIButton9', '#idBtn_Back', '#acceptButton',
  'button:has-text("Yes")', 'button:has-text("Accept")', 'button:has-text("Continue")',
  'button:has-text("Stay signed in")', 'button:has-text("Approve")',
];

interface CachedAuth {
  headers: Record<string, string>;
  capturedAt: number;
}

// ---------------------------------------------------------------------------
// Hermes broker — AUTHORITATIVE auth path.
//
// Hermes is the operator's canonical credential broker. When CONFIGURED
// (HERMES_URL + HERMES_CLIENT_TOKEN both set) it OWNS the full auth lifecycle:
// acquisition, refresh, autoReacquire on expiry, headless SSO reseed. This MCP
// becomes a thin consumer instead of running its own parallel embedded SSO.
//
// Fail-loud contract (no silent fallback to embedded browser auth):
//   - Hermes CONFIGURED but failing  → log ERROR + THROW. The embedded SSO /
//     local-cookie-cache fallback is gated behind SERVICENOW_LEGACY_AUTH=true
//     (default off). Without that flag, a configured-but-down broker is a hard
//     error — it must never silently degrade to the embedded Playwright path.
//   - Hermes NOT configured          → the embedded/local path is legitimate.
//
// Service + scheme are configurable; defaults match the operator convention.
// ---------------------------------------------------------------------------
const HERMES_SERVICE = process.env.HERMES_SERVICE || "servicenow";
const HERMES_SCHEME = process.env.HERMES_SCHEME || "session";

/** True when both Hermes env vars are present — Hermes is the authoritative path. */
export function hermesConfigured(): boolean {
  return !!(process.env.HERMES_URL && process.env.HERMES_CLIENT_TOKEN);
}

/** True when the operator has explicitly opted into legacy embedded auth. */
export function legacyAuthEnabled(): boolean {
  return (process.env.SERVICENOW_LEGACY_AUTH || "").toLowerCase() === "true";
}

class HermesAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesAuthError";
  }
}

/**
 * Fetch auth headers from the Hermes broker.
 *
 * Preconditions: caller has verified hermesConfigured() === true.
 *
 * The GET ${HERMES_URL}/token/<service>/<scheme> endpoint returns:
 *   { accessToken: "<full Cookie header>", extra: { g_ck: "<csrf>" }, ... }
 * which maps directly to this MCP's headers shape.
 *
 * THROWS HermesAuthError on any failure (409, non-2xx, missing token, network).
 * The caller decides whether a throw is fatal (default) or whether to fall
 * through to legacy embedded auth (only when SERVICENOW_LEGACY_AUTH=true).
 */
async function loadFromHermes(): Promise<Record<string, string>> {
  const hermesUrl = process.env.HERMES_URL!;
  const hermesToken = process.env.HERMES_CLIENT_TOKEN!;
  const endpoint = `${hermesUrl}/token/${HERMES_SERVICE}/${HERMES_SCHEME}`;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${hermesToken}` },
    });
  } catch (err) {
    throw new HermesAuthError(
      `Hermes broker unreachable at ${endpoint}: ${(err as Error).message}`,
    );
  }

  if (resp.status === 409) {
    const body = (await resp.json().catch(() => ({}))) as {
      code?: string;
      remediation?: string;
    };
    throw new HermesAuthError(
      `Hermes ${endpoint} returned 409 (${body.code ?? "ACQUIRE_REQUIRED"}). ` +
        `Remediation: ${body.remediation ?? `run \`hermes acquire ${HERMES_SERVICE}\``}.`,
    );
  }

  if (!resp.ok) {
    throw new HermesAuthError(
      `Hermes ${endpoint} returned HTTP ${resp.status}.`,
    );
  }

  const body = (await resp.json().catch((err) => {
    throw new HermesAuthError(
      `Hermes ${endpoint} returned an unparseable body: ${(err as Error).message}`,
    );
  })) as { accessToken?: string; extra?: { g_ck?: string } };

  if (!body.accessToken) {
    throw new HermesAuthError(
      `Hermes ${endpoint} returned a token bundle without accessToken.`,
    );
  }

  const headers: Record<string, string> = {
    Cookie: body.accessToken,
    Accept: "application/json",
  };
  if (body.extra?.g_ck) {
    headers["X-UserToken"] = body.extra.g_ck;
  }
  console.error(`✅ Loaded auth from Hermes (${body.extra?.g_ck ? "with" : "without"} g_ck)`);
  return headers;
}

function loadCache(): Record<string, string> | null {
  // Try local cache first, then volume-mounted host cookie file
  for (const file of [CACHE_FILE, MOUNTED_COOKIE_FILE]) {
    if (!existsSync(file)) continue;
    try {
      const data: CachedAuth = JSON.parse(readFileSync(file, "utf-8"));
      if (data.headers?.Cookie && Date.now() - data.capturedAt < CACHE_TTL) {
        console.error(`✅ Loaded auth from ${file === CACHE_FILE ? "local cache" : "host cookie file"}`);
        return data.headers;
      }
    } catch { /* corrupt cache */ }
  }
  console.error("⚠️  No valid cookie cache found (checked local + host-mounted)");
  return null;
}

function saveCache(headers: Record<string, string>): void {
  const data: CachedAuth = { headers, capturedAt: Date.now() };
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

// Session keepalive — ping ServiceNow periodically to prevent session timeout
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
let lastKnownHeaders: Record<string, string> | null = null;

export function startSessionKeepalive(): void {
  if (keepaliveInterval) return;
  const KEEPALIVE_MS = 10 * 60 * 1000; // 10 minutes
  keepaliveInterval = setInterval(async () => {
    const headers = lastKnownHeaders || loadCache();
    if (!headers?.Cookie) return;
    try {
      const resp = await fetch(`${TARGET_URL}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id`, {
        headers: { ...headers, Accept: "application/json" },
      });
      if (resp.ok) {
        console.error("🏓 Session keepalive OK");
        // Re-save with fresh timestamp so TTL doesn't expire
        saveCache(headers);
      } else {
        console.error(`⚠️  Session keepalive failed: ${resp.status}`);
      }
    } catch (e) {
      console.error(`⚠️  Session keepalive error: ${(e as Error).message}`);
    }
  }, KEEPALIVE_MS);
  console.error(`🏓 Session keepalive started (every ${KEEPALIVE_MS / 60000}min)`);
}

export function clearCache(): void {
  try { if (existsSync(CACHE_FILE)) writeFileSync(CACHE_FILE, "{}"); } catch {}
}

function keychainGet(label: string): string {
  // Fall back to env vars in containerized environments where macOS Keychain is unavailable
  const envMap: Record<string, string> = {
    "corp-sso-email": process.env.SERVICENOW_USERNAME || "",
    "corp-sso-password": process.env.SERVICENOW_PASSWORD || "",
  };
  if (envMap[label]) return envMap[label];
  try {
    return execSync(`security find-generic-password -l "${label}" -w`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

async function authenticate(): Promise<Record<string, string>> {
  const email = keychainGet("corp-sso-email");
  const password = keychainGet("corp-sso-password");

  console.error("🔐 Headless SSO authentication...");

  const browser = await firefox.launch({
    headless: true,
    firefoxUserPrefs: { "security.default_personal_cert": "Select Automatically" },
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    for (let i = 0; i < 20; i++) {
      const onTarget = page.url().includes(TARGET_HOST);
      const hasLogin = await page.$$('input[type="email"]:visible, input[type="password"]:visible, input[name="loginfmt"]:visible, input[name="passwd"]:visible');
      if (onTarget && hasLogin.length === 0) break;

      // Email
      let filledEmail = false;
      for (const sel of EMAIL_SELECTORS) {
        const el = await page.$(sel).catch(() => null);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        const val = await el.inputValue().catch(() => "");
        if (visible && !val) {
          await page.evaluate(({ s, v }: { s: string; v: string }) => {
            const input = document.querySelector(s) as HTMLInputElement;
            if (input) { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); }
          }, { s: sel, v: email });
          const btn = await page.$('input[type="submit"]:visible, button[type="submit"]:visible, #idSIButton9:visible');
          if (btn) await btn.click().catch(() => {});
          await page.waitForNavigation({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(2000);
          filledEmail = true;
          break;
        }
      }
      if (filledEmail) continue;

      // Password
      let filledPw = false;
      for (const sel of PW_SELECTORS) {
        const el = await page.$(sel).catch(() => null);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        const val = await el.inputValue().catch(() => "");
        if (visible && !val) {
          await page.evaluate(({ s, v }: { s: string; v: string }) => {
            const input = document.querySelector(s) as HTMLInputElement;
            if (input) { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); }
          }, { s: sel, v: password });
          const btn = await page.$('input[type="submit"]:visible, button[type="submit"]:visible, #idSIButton9:visible');
          if (btn) await btn.click().catch(() => {});
          await page.waitForNavigation({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(2000);
          filledPw = true;
          break;
        }
      }
      if (filledPw) continue;

      // Consent / MFA buttons
      let clickedConsent = false;
      for (const sel of CONSENT_SELECTORS) {
        const btn = await page.$(sel).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(3000);
          clickedConsent = true;
          break;
        }
      }
      if (!clickedConsent) await page.waitForTimeout(5000);
    }

    // Post-login: navigate to target again to ensure SN session is active
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    // Extract g_ck (CSRF token) from window globals and frames
    const tokens: Record<string, string> = await page.evaluate(() => {
      const t: Record<string, string> = {};
      for (const key of Object.keys(window)) {
        const val = (window as any)[key];
        if (typeof val === "string" && val.length > 10 && val.length < 500 &&
            (key.toLowerCase().includes("token") || key.toLowerCase().includes("csrf") ||
             key === "g_ck" || key === "_csrf"))
          t[key] = val;
      }
      return t;
    });

    // Also check frames (navpage.do framesets)
    if (!tokens.g_ck) {
      for (const frame of page.frames()) {
        try {
          const gck = await frame.evaluate(() => (window as any).g_ck || "");
          if (gck) { tokens.g_ck = gck; break; }
        } catch { /* cross-origin */ }
      }
    }

    // Also try REST API call in-browser to activate API session + get g_ck
    if (!tokens.g_ck) {
      try {
        const gck = await page.evaluate(async () => {
          const r = await fetch("/api/now/ui/user/session_info", {
            credentials: "same-origin", headers: { Accept: "application/json" },
          });
          if (r.ok) { const d = await r.json(); return d?.result?.g_ck || ""; }
          return "";
        });
        if (gck) tokens.g_ck = gck;
      } catch { /* ignore */ }
    }

    // Also activate REST session so cookies work outside browser
    try {
      await page.evaluate(async () => {
        await fetch("/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id", {
          credentials: "same-origin", headers: { Accept: "application/json" },
        });
      });
    } catch { /* ignore */ }

    // Re-capture cookies after REST activation
    const finalCookies = await context.cookies();
    const finalCookieHeader = finalCookies.map(c => `${c.name}=${c.value}`).join("; ");

    const csrfHeaders: Record<string, string> = {};
    if (tokens.g_ck) csrfHeaders["X-UserToken"] = tokens.g_ck;

    const finalHeaders: Record<string, string> = {
      Cookie: finalCookieHeader,
      ...csrfHeaders,
      Accept: "application/json",
    };

    console.error(`✅ Auth complete (${finalCookies.length} cookies, g_ck=${!!tokens.g_ck})`);
    saveCache(finalHeaders);
    return finalHeaders;
  } finally {
    await browser.close();
  }
}

let authPromise: Promise<Record<string, string>> | null = null;

export async function getAuthHeaders(): Promise<Record<string, string>> {
  // Hermes is the AUTHORITATIVE auth path when configured. It owns the auth
  // lifecycle (acquisition, refresh, autoReacquire on expiry, headless SSO
  // reseed). There is NO silent fallback to embedded browser auth: if Hermes
  // is configured but failing, this throws unless the operator has explicitly
  // opted into legacy auth via SERVICENOW_LEGACY_AUTH=true.
  if (hermesConfigured()) {
    try {
      const fromHermes = await loadFromHermes();
      // Hermes owns the credential. Do NOT persist plaintext cookies to the
      // local cache on the Hermes path — only the legacy path uses .cookie-cache.json.
      lastKnownHeaders = fromHermes;
      return fromHermes;
    } catch (err) {
      const message = (err as Error).message;
      if (!legacyAuthEnabled()) {
        console.error(
          `❌ Hermes auth failed and SERVICENOW_LEGACY_AUTH is not enabled. ` +
            `Refusing to fall back to embedded SSO. ${message}`,
        );
        throw new HermesAuthError(
          `ServiceNow auth via Hermes failed: ${message} ` +
            `Set SERVICENOW_LEGACY_AUTH=true to permit the embedded-browser fallback (not recommended).`,
        );
      }
      console.error(
        `⚠️  Hermes auth failed; SERVICENOW_LEGACY_AUTH=true — falling through to legacy embedded auth. ${message}`,
      );
      // fall through to legacy cache / SSO env path below
    }
  }

  const cached = loadCache();
  if (cached && cached.Cookie) {
    lastKnownHeaders = cached;
    startSessionKeepalive();
    return cached;
  }

  // Check for pre-set session token env vars (skip SSO entirely)
  if (process.env.SERVICENOW_SESSION_TOKEN) {
    const headers: Record<string, string> = {
      Cookie: process.env.SERVICENOW_SESSION_TOKEN,
      Accept: "application/json",
    };
    if (process.env.SERVICENOW_USER_TOKEN) {
      headers["X-UserToken"] = process.env.SERVICENOW_USER_TOKEN;
    }
    return headers;
  }

  // Don't auto-trigger headless SSO — it blocks on MFA.
  // Return empty headers; user should call auth_browser or auth_import_cookies first.
  console.error("⚠️  No cached auth. Use auth_browser or auth_import_cookies to authenticate.");
  return { Accept: "application/json" };
}

export async function triggerSSOAuth(): Promise<Record<string, string>> {
  // Explicit embedded-SSO trigger (called by the auth_browser tool only).
  // This is a LEGACY embedded-auth path. When Hermes is the authoritative
  // broker, the embedded Playwright SSO must not run — Hermes owns auth.
  if (hermesConfigured() && !legacyAuthEnabled()) {
    throw new HermesAuthError(
      "Embedded browser SSO is disabled: Hermes is the authoritative auth broker. " +
        `Acquire the credential through Hermes (e.g. \`hermes acquire ${HERMES_SERVICE}\`). ` +
        "Set SERVICENOW_LEGACY_AUTH=true only if you must use the embedded-browser fallback.",
    );
  }
  if (!authPromise) {
    authPromise = authenticate().finally(() => { authPromise = null; });
  }
  return authPromise;
}
