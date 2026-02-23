#!/usr/bin/env node
/**
 * Host-side ServiceNow authentication script.
 * 
 * Runs on macOS host (not in container) to capture SSO cookies via browser.
 * The host has device certificates that satisfy Conditional Access Policies.
 * 
 * Cookies are saved to ~/.servicenow-mcp/cookies.json, which is volume-mounted
 * into the container so it can use them immediately.
 * 
 * Usage: node scripts/host-auth.mjs [--headless]
 */

import { firefox } from "playwright";
import { createHmac } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".servicenow-mcp");
const COOKIE_FILE = join(CONFIG_DIR, "cookies.json");
const HEADLESS = process.argv.includes("--headless");
const INSTANCE_URL = process.env.SERVICENOW_INSTANCE_URL || "https://instance.service-now.com";
const TARGET_HOST = new URL(INSTANCE_URL).hostname;

mkdirSync(CONFIG_DIR, { recursive: true });

function generateTOTP(base32Secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = base32Secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of cleaned) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const secretBytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < secretBytes.length; i++) secretBytes[i] = parseInt(bits.substring(i * 8, i * 8 + 8), 2);
  const time = Math.floor(Date.now() / 30000);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigUInt64BE(BigInt(time));
  const hmac = createHmac("sha1", secretBytes).update(timeBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
  return code.toString().padStart(6, "0");
}

const EMAIL_SELECTORS = [
  'input[name="loginfmt"]', 'input[type="email"]', 'input[name="email"]',
  'input[name="username"]', 'input[name="user"]',
];
const PW_SELECTORS = [
  'input[name="passwd"]', 'input[type="password"]', 'input[name="password"]',
];
const TOTP_SELECTORS = [
  'input[name="otc"]', 'input#idTxtBx_SAOTCC_OTC', 'input[placeholder*="code"]',
];
const CONSENT_SELECTORS = [
  '#idSIButton9', '#idBtn_Back', '#acceptButton',
  'button:has-text("Yes")', 'button:has-text("Accept")', 'button:has-text("Continue")',
  'button:has-text("Stay signed in")', 'button:has-text("Approve")',
];

async function main() {
  const email = process.env.SERVICENOW_USERNAME || process.env.MS365_USERNAME || "";
  const password = process.env.SERVICENOW_PASSWORD || process.env.MS365_PASSWORD || "";
  const totpSecret = process.env.TOTP_SECRET || "";

  if (!email || !password) {
    // Try macOS Keychain
    const { execSync } = await import("node:child_process");
    const getKey = (label) => {
      try { return execSync(`security find-generic-password -l "${label}" -w`, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"] }).trim(); }
      catch { return ""; }
    };
    const kcEmail = getKey("corp-sso-email") || email;
    const kcPass = getKey("corp-sso-password") || password;
    if (!kcEmail || !kcPass) {
      console.error("❌ Set SERVICENOW_USERNAME + SERVICENOW_PASSWORD env vars, or add corp-sso-email/corp-sso-password to macOS Keychain");
      process.exit(1);
    }
    process.env.SERVICENOW_USERNAME = kcEmail;
    process.env.SERVICENOW_PASSWORD = kcPass;
  }

  const finalEmail = process.env.SERVICENOW_USERNAME;
  const finalPassword = process.env.SERVICENOW_PASSWORD;

  console.log(`🔐 ServiceNow host-side auth (${HEADLESS ? "headless" : "visible"} browser)`);
  console.log(`   Instance: ${INSTANCE_URL}`);
  console.log(`   User: ${finalEmail}`);

  const browser = await firefox.launch({
    headless: HEADLESS,
    firefoxUserPrefs: { "security.default_personal_cert": "Select Automatically" },
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    console.log("🌐 Navigating to ServiceNow...");
    await page.goto(INSTANCE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    for (let step = 0; step < 25; step++) {
      const url = page.url();
      const onTarget = url.includes(TARGET_HOST) && !url.includes("login.microsoftonline.com");
      const hasLoginForm = await page.$$('input[type="email"]:visible, input[type="password"]:visible, input[name="loginfmt"]:visible, input[name="passwd"]:visible, input[name="otc"]:visible');

      if (onTarget && hasLoginForm.length === 0) {
        console.log("✅ Landed on ServiceNow — SSO complete");
        break;
      }

      // Email step
      let acted = false;
      for (const sel of EMAIL_SELECTORS) {
        const el = await page.$(sel).catch(() => null);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        const val = await el.inputValue().catch(() => "filled");
        if (visible && !val) {
          console.log("📧 Filling email...");
          await el.fill(finalEmail);
          const btn = await page.$('input[type="submit"]:visible, button[type="submit"]:visible, #idSIButton9:visible');
          if (btn) await btn.click().catch(() => {});
          await page.waitForNavigation({ timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(2000);
          acted = true;
          break;
        }
      }
      if (acted) continue;

      // Password step
      for (const sel of PW_SELECTORS) {
        const el = await page.$(sel).catch(() => null);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        const val = await el.inputValue().catch(() => "filled");
        if (visible && !val) {
          console.log("🔑 Filling password...");
          await el.fill(finalPassword);
          const btn = await page.$('input[type="submit"]:visible, button[type="submit"]:visible, #idSIButton9:visible');
          if (btn) await btn.click().catch(() => {});
          await page.waitForNavigation({ timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(2000);
          acted = true;
          break;
        }
      }
      if (acted) continue;

      // TOTP step
      if (totpSecret) {
        for (const sel of TOTP_SELECTORS) {
          const el = await page.$(sel).catch(() => null);
          if (!el) continue;
          const visible = await el.isVisible().catch(() => false);
          const val = await el.inputValue().catch(() => "filled");
          if (visible && !val) {
            const code = generateTOTP(totpSecret);
            console.log(`🔢 Filling TOTP code...`);
            await el.fill(code);
            const btn = await page.$('input[type="submit"]:visible, button[type="submit"]:visible, #idSIButton9:visible, #idSubmit_SAOTCC_Continue:visible');
            if (btn) await btn.click().catch(() => {});
            await page.waitForNavigation({ timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(2000);
            acted = true;
            break;
          }
        }
        if (acted) continue;
      }

      // Consent / Stay signed in
      for (const sel of CONSENT_SELECTORS) {
        const btn = await page.$(sel).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) {
          console.log("👆 Clicking consent/continue...");
          await btn.click().catch(() => {});
          await page.waitForTimeout(3000);
          acted = true;
          break;
        }
      }

      if (!acted) {
        console.log(`   Step ${step}: waiting... (${url.substring(0, 80)})`);
        await page.waitForTimeout(5000);
      }
    }

    // Ensure we're on ServiceNow
    if (!page.url().includes(TARGET_HOST)) {
      console.log("🔄 Navigating back to ServiceNow...");
      await page.goto(INSTANCE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000);
    }

    // Activate REST API session
    console.log("🔧 Activating REST API session...");
    let gCk = "";
    try {
      gCk = await page.evaluate(async () => {
        const r = await fetch("/api/now/ui/user/session_info", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (r.ok) {
          const d = await r.json();
          return d?.result?.g_ck || "";
        }
        return "";
      });
    } catch (e) {
      console.warn("⚠️  Could not get g_ck from session_info:", e.message);
    }

    // Also try frames (navpage.do)
    if (!gCk) {
      for (const frame of page.frames()) {
        try {
          gCk = await frame.evaluate(() => window.g_ck || "");
          if (gCk) break;
        } catch { /* cross-origin */ }
      }
    }

    // Make a REST call to ensure API session is active
    try {
      await page.evaluate(async () => {
        await fetch("/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
      });
    } catch { /* ignore */ }

    // Capture cookies
    const allCookies = await context.cookies();
    const snCookies = allCookies.filter(c =>
      c.domain.includes(TARGET_HOST) ||
      c.domain.includes("service-now.com") ||
      c.domain.includes("microsoftonline.com")
    );

    const cookieHeader = snCookies.map(c => `${c.name}=${c.value}`).join("; ");

    // Primary format: { headers, capturedAt } — used by auth.ts loadCache()
    // Also includes loadCookies() fields for auth-browser.ts compatibility
    const result = {
      headers: {
        Cookie: cookieHeader,
        Accept: "application/json",
        ...(gCk ? { "X-UserToken": gCk } : {}),
      },
      capturedAt: Date.now(),
      instanceUrl: INSTANCE_URL,
      cookieCount: snCookies.length,
      hasUserToken: !!gCk,
      // Fields for auth-browser.ts loadCookies()
      cookies: snCookies,
      userToken: gCk || "",
      timestamp: new Date().toISOString(),
    };

    writeFileSync(COOKIE_FILE, JSON.stringify(result, null, 2));
    console.log(`\n✅ ServiceNow auth captured!`);
    console.log(`   ${snCookies.length} cookies, g_ck=${!!gCk}`);
    console.log(`   Saved to: ${COOKIE_FILE}`);

    // Also write the legacy .cookie-cache.json format for direct use
    const legacyCacheFile = join(process.cwd(), ".cookie-cache.json");
    try {
      writeFileSync(legacyCacheFile, JSON.stringify(result, null, 2));
    } catch { /* ignore if cwd is not writable */ }

    // Verify the cookies work
    console.log("\n🧪 Verifying...");
    const verifyResp = await fetch(`${INSTANCE_URL}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id,user_name`, {
      headers: result.headers,
    });
    if (verifyResp.ok) {
      const data = await verifyResp.json();
      console.log(`✅ Verified — API working (${JSON.stringify(data?.result?.[0]?.user_name || "ok")})`);
    } else {
      console.error(`⚠️  Verification failed: ${verifyResp.status}`);
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error("❌ Auth failed:", e.message);
  process.exit(1);
});
