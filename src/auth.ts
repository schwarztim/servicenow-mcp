/**
 * Clean auth module following sun-demo DIRECT pipeline.
 * Headless-only. Credentials from macOS Keychain via `security` CLI.
 * Exports getAuthHeaders() — lazy, cached, no Bearer tokens.
 */

import { firefox } from "playwright";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE_FILE = join(PROJECT_DIR, ".cookie-cache.json");
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

function loadCache(): Record<string, string> | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const data: CachedAuth = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (Date.now() - data.capturedAt < CACHE_TTL) return data.headers;
    console.error("⚠️  Cookie cache expired");
  } catch { /* corrupt cache */ }
  return null;
}

function saveCache(headers: Record<string, string>): void {
  const data: CachedAuth = { headers, capturedAt: Date.now() };
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

export function clearCache(): void {
  try { if (existsSync(CACHE_FILE)) writeFileSync(CACHE_FILE, "{}"); } catch {}
}

function keychainGet(label: string): string {
  return execSync(`security find-generic-password -l "${label}" -w`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
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

    // Collect cookies
    const allCookies = await context.cookies();
    const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join("; ");

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
  const cached = loadCache();
  if (cached && cached.Cookie) return cached;

  // Deduplicate concurrent calls
  if (!authPromise) {
    authPromise = authenticate().finally(() => { authPromise = null; });
  }
  return authPromise;
}
