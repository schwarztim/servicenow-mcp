#!/usr/bin/env node
/**
 * ServiceNow Browser Authentication
 *
 * Launches a browser for SSO login and captures session cookies.
 * Cookies are saved to ~/.servicenow-mcp/cookies.json for MCP to use.
 */

import { chromium, type Cookie } from "playwright";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COOKIE_DIR = join(homedir(), ".servicenow-mcp");
const COOKIE_FILE = join(COOKIE_DIR, "cookies.json");

export interface AuthResult {
  success: boolean;
  instanceUrl: string;
  cookies: Cookie[];
  userToken?: string;
  error?: string;
}

export async function authenticateViaBrowser(
  instanceUrl: string,
): Promise<AuthResult> {
  console.log(`\n🔐 ServiceNow Browser Authentication`);
  console.log(`   Instance: ${instanceUrl}`);
  console.log(
    `   A browser window will open. Please log in using your SSO credentials.\n`,
  );

  const browser = await chromium.launch({
    headless: false, // User needs to see and interact
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    // Navigate to ServiceNow
    await page.goto(instanceUrl, { waitUntil: "networkidle" });

    console.log("⏳ Waiting for you to complete SSO login...");
    console.log(
      "   (The browser will close automatically once authenticated)\n",
    );

    // Wait for successful authentication by detecting:
    // 1. URL no longer contains login/saml/sso keywords
    // 2. We're on a ServiceNow page (contains nav or workspace)
    let authenticated = false;
    let attempts = 0;
    const maxAttempts = 300; // 5 minutes - allows time for MFA flows

    while (!authenticated && attempts < maxAttempts) {
      await page.waitForTimeout(1000);
      const currentUrl = page.url();

      // Check if we're past the login page
      const isLoginPage =
        currentUrl.includes("/login") ||
        currentUrl.includes("/saml") ||
        currentUrl.includes("/sso") ||
        currentUrl.includes("idp") ||
        currentUrl.includes("okta") ||
        currentUrl.includes("auth0") ||
        currentUrl.includes("login.microsoftonline");

      const isServiceNowPage =
        currentUrl.includes("service-now.com") &&
        (currentUrl.includes("/nav/") ||
          currentUrl.includes("/now/") ||
          currentUrl.includes("/$") ||
          currentUrl.includes("/welcome"));

      if (!isLoginPage && isServiceNowPage) {
        authenticated = true;
        console.log("✅ Authentication detected!");
      }

      attempts++;
    }

    if (!authenticated) {
      throw new Error("Authentication timeout. Please try again.");
    }

    // Get all cookies from the session
    const cookies = await context.cookies();

    // Try to extract user token from page (used for CSRF protection)
    let userToken: string | undefined;
    try {
      userToken = await page.evaluate(() => {
        // ServiceNow stores g_ck (security token) in window object
        return (window as any).g_ck || (window as any).NOW?.g_ck || "";
      });
    } catch {
      // Token extraction optional
    }

    // Save cookies to file
    ensureCookieDir();
    const cookieData = {
      instanceUrl: instanceUrl.replace(/\/$/, ""),
      cookies: cookies,
      userToken: userToken,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(COOKIE_FILE, JSON.stringify(cookieData, null, 2));

    console.log(`\n✅ Authentication successful!`);
    console.log(`   Cookies saved to: ${COOKIE_FILE}`);
    console.log(`   Found ${cookies.length} cookies`);
    if (userToken) {
      console.log(`   User token captured`);
    }

    await browser.close();

    return {
      success: true,
      instanceUrl: instanceUrl.replace(/\/$/, ""),
      cookies,
      userToken,
    };
  } catch (error) {
    await browser.close();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Authentication failed: ${message}`);
    return {
      success: false,
      instanceUrl,
      cookies: [],
      error: message,
    };
  }
}

function ensureCookieDir(): void {
  if (!existsSync(COOKIE_DIR)) {
    mkdirSync(COOKIE_DIR, { recursive: true });
  }
}

export function loadCookies(): {
  cookies: string;
  userToken: string;
  instanceUrl: string;
} | null {
  try {
    if (!existsSync(COOKIE_FILE)) {
      return null;
    }
    const data = JSON.parse(readFileSync(COOKIE_FILE, "utf-8"));

    // Check if cookies are expired (older than 45 minutes)
    // ServiceNow sessions typically expire in ~1 hour, so we check earlier
    const timestamp = new Date(data.timestamp);
    const ageMinutes = (Date.now() - timestamp.getTime()) / (1000 * 60);
    if (ageMinutes > 45) {
      console.error(
        "⚠️  Cookies are older than 45 minutes (ServiceNow sessions expire in ~1 hour). Please re-authenticate with auth_browser tool.",
      );
      return null;
    }

    // Format cookies as header string
    const cookieString = data.cookies
      .map((c: Cookie) => `${c.name}=${c.value}`)
      .join("; ");

    return {
      cookies: cookieString,
      userToken: data.userToken || "",
      instanceUrl: data.instanceUrl,
    };
  } catch {
    return null;
  }
}

// CLI entry point
if (
  process.argv[1]?.endsWith("auth-browser.ts") ||
  process.argv[1]?.endsWith("auth-browser.js")
) {
  const instanceUrl = process.argv[2] || process.env.SERVICENOW_INSTANCE_URL;

  if (!instanceUrl) {
    console.error("Usage: npm run auth <SERVICENOW_INSTANCE_URL>");
    console.error("   Or: set SERVICENOW_INSTANCE_URL environment variable");
    process.exit(1);
  }

  authenticateViaBrowser(instanceUrl)
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
}
