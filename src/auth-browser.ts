#!/usr/bin/env node
/**
 * ServiceNow Browser Authentication
 *
 * Launches a browser for SSO login and captures session cookies.
 * Cookies are saved to ~/.servicenow-mcp/cookies.json for MCP to use.
 */

import { firefox, type Cookie } from "playwright";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { AzureADAutomator } from "./azure-ad-automator.js";
import { Logger } from "./logger.js";
import { ConfigManager, type AuthConfig } from "./auth-config.js";
import { CredentialStore } from "./credential-store.js";

const COOKIE_DIR = join(homedir(), ".servicenow-mcp");
const COOKIE_FILE = join(COOKIE_DIR, "cookies.json");

// Cross-platform user agent for Firefox
function getUserAgent(): string {
  const os = platform();
  if (os === "win32") {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0";
  } else if (os === "darwin") {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0";
  } else {
    // Linux and others
    return "Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0";
  }
}

export interface AuthResult {
  success: boolean;
  instanceUrl: string;
  cookies: Cookie[];
  userToken?: string;
  error?: string;
}

/**
 * Helper function to detect if we've successfully authenticated to ServiceNow
 */
async function isOnServiceNowPage(page: any): Promise<boolean> {
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
    (currentUrl.includes("/nav") || // Navigator UI
      currentUrl.includes("/now/") || // Next Experience
      currentUrl.includes("/$") || // Dollar sign paths
      currentUrl.includes("/welcome") || // Welcome page
      currentUrl.includes("/home") || // Homepage
      currentUrl.includes("/sp") || // Service Portal
      currentUrl.includes("/csm") || // Customer Service Management
      currentUrl.includes("/esc") || // Employee Service Center
      currentUrl.includes("/hrsd") || // HR Service Delivery
      currentUrl.includes("/itsm") || // IT Service Management
      currentUrl.includes("/incident") || // Incident management
      currentUrl.includes("/kb_") || // Knowledge Base
      currentUrl.includes("/ui/") || // UI pages
      new URL(currentUrl).pathname === "/"); // Root path

  return !isLoginPage && isServiceNowPage;
}

export async function authenticateViaBrowser(
  instanceUrl: string,
  options?: {
    email?: string;
    password?: string;
    mfaScript?: string;
    headless?: boolean;
    config?: AuthConfig;
  },
): Promise<AuthResult> {
  const logger = new Logger("INFO");

  // ALWAYS try to load config and credentials if not provided
  if (!options?.email || !options?.password) {
    logger.info("📋 No credentials provided, checking config...");
    const configManager = new ConfigManager();
    const config = configManager.load();
    if (config) {
      const credentialStore = new CredentialStore();
      const password = await credentialStore.getPassword(config.email);
      if (password) {
        options = {
          ...options,
          email: config.email,
          password: password,
          mfaScript: options?.mfaScript || config.mfaScript || "",
          headless: options?.headless ?? config.headless ?? true, // Default to headless
          config: config,
        };
        logger.info("✅ Loaded credentials from config and keychain");
      } else {
        logger.warn("⚠️  Config found but password not in keychain");
      }
    } else {
      logger.warn("⚠️  No config found");
    }
  }

  // Determine if we should attempt automated login
  const isAutomated =
    options?.headless !== false && options?.email && options?.password;

  if (isAutomated && options) {
    logger.info("🤖 ServiceNow Automated Authentication");
    logger.info(`   Instance: ${instanceUrl}`);
    logger.info(`   Email: ${options.email}`);
    logger.info(`   Mode: Headless with automated Azure AD login`);
  } else {
    logger.info("🔐 ServiceNow Browser Authentication");
    logger.info(`   Instance: ${instanceUrl}`);
    logger.info(
      "   A browser window will open. Please log in using your SSO credentials.",
    );
  }

  let browser = await firefox.launch({
    headless: options?.headless ?? true, // Default to headless (background)
  });

  let context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: getUserAgent(),
  });

  let page = await context.newPage();
  let needsVisibleFallback = false;

  try {
    // Navigate to ServiceNow
    await page.goto(instanceUrl, { waitUntil: "networkidle" });

    // Automated login flow
    if (isAutomated && options?.email && options?.password) {
      logger.info("🔄 Attempting automated Azure AD login...");

      const automator = new AzureADAutomator(logger);

      const automationResult = await automator.performLogin(
        page,
        {
          email: options.email,
          password: options.password,
          mfaScript: options.mfaScript || "",
        },
        90000,
        instanceUrl,
      );

      if (!automationResult.success) {
        logger.error(`Automated login failed: ${automationResult.error}`);

        // Check if this was a push MFA situation
        if (automationResult.requiresManualMfa) {
          logger.info(
            "📱 Push MFA detected - opening visible browser for approval...",
          );
        } else {
          logger.info(
            "💡 Falling back to visible browser for manual authentication...",
          );
        }

        // CRITICAL FIX: Close headless browser and relaunch as visible
        // The old code left the browser headless, making "manual" auth impossible
        if (options?.headless !== false) {
          needsVisibleFallback = true;
          await browser.close();

          // Re-launch browser in VISIBLE mode
          browser = await firefox.launch({ headless: false });
          context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            userAgent: getUserAgent(),
          });
          page = await context.newPage();

          // Navigate back to ServiceNow
          await page.goto(instanceUrl, { waitUntil: "networkidle" });
          logger.info(
            "🌐 Visible browser opened - please complete authentication",
          );
        }
      } else {
        logger.info("✅ Automated login successful!");
      }
    }

    // Manual authentication flow (or fallback from failed automation)
    if (
      !isAutomated ||
      needsVisibleFallback ||
      !(await isOnServiceNowPage(page))
    ) {
      if (!isAutomated) {
        logger.info("⏳ Waiting for you to complete SSO login...");
        logger.info(
          "   (The browser will close automatically once authenticated)",
        );
      } else if (needsVisibleFallback) {
        logger.info("⏳ Waiting for manual authentication...");
        logger.info("   Complete the login in the browser window");
      }

      // Wait for successful authentication by detecting:
      // 1. URL no longer contains login/saml/sso keywords
      // 2. We're on a ServiceNow page (contains nav or workspace)
      let authenticated = false;
      let attempts = 0;
      const maxAttempts = 300; // 5 minutes - allows time for MFA flows

      while (!authenticated && attempts < maxAttempts) {
        await page.waitForTimeout(1000);

        if (await isOnServiceNowPage(page)) {
          authenticated = true;
          logger.info("✅ Authentication detected!");
        }

        attempts++;
      }

      if (!authenticated) {
        throw new Error("Authentication timeout. Please try again.");
      }
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

    logger.info("✅ Authentication successful!");
    logger.info(`   Cookies saved to: ${COOKIE_FILE}`);
    logger.info(`   Found ${cookies.length} cookies`);
    if (userToken) {
      logger.info(`   User token captured`);
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
    logger.error(`❌ Authentication failed: ${message}`);
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

    // Check if cookies are expired (older than 4 hours)
    // ServiceNow sessions can last 8+ hours depending on instance config
    // We use 4 hours as a reasonable balance between session validity and refresh frequency
    const timestamp = new Date(data.timestamp);
    const ageMinutes = (Date.now() - timestamp.getTime()) / (1000 * 60);
    if (ageMinutes > 240) {
      console.error(
        "⚠️  Cookies are older than 4 hours. Please re-authenticate with auth_browser or auth_import_cookies tool.",
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

/**
 * Import cookies from external source (e.g., Firefox DevTools network headers)
 * This is useful when the user already has an authenticated session in the browser
 */
export function importCookies(
  instanceUrl: string,
  cookieString: string,
  userToken?: string,
): { success: boolean; error?: string } {
  try {
    ensureCookieDir();

    // Parse cookie string into array of Cookie-like objects
    const cookies = cookieString.split(";").map((pair) => {
      const [name, ...valueParts] = pair.trim().split("=");
      return {
        name: name.trim(),
        value: valueParts.join("=").trim(),
        domain: new URL(instanceUrl).hostname,
        path: "/",
      };
    });

    const cookieData = {
      instanceUrl: instanceUrl.replace(/\/$/, ""),
      cookies: cookies,
      userToken: userToken || "",
      timestamp: new Date().toISOString(),
      source: "imported", // Mark as imported for debugging
    };

    writeFileSync(COOKIE_FILE, JSON.stringify(cookieData, null, 2));

    console.log(`\n✅ Cookies imported successfully!`);
    console.log(`   Instance: ${instanceUrl}`);
    console.log(`   Cookies saved to: ${COOKIE_FILE}`);
    console.log(`   Cookie count: ${cookies.length}`);
    if (userToken) {
      console.log(`   User token: captured`);
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Cookie import failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Refresh existing session by re-authenticating with stored instance URL
 */
export async function refreshSession(): Promise<AuthResult> {
  const existing = loadCookies();
  if (!existing) {
    return {
      success: false,
      instanceUrl: "",
      cookies: [],
      error: "No existing session to refresh. Use auth_browser first.",
    };
  }
  return authenticateViaBrowser(existing.instanceUrl);
}

// CLI entry point
if (
  process.argv[1]?.endsWith("auth-browser.ts") ||
  process.argv[1]?.endsWith("auth-browser.js")
) {
  // Parse CLI arguments
  const args = process.argv.slice(2);
  const forceVisible = args.includes("--visible") || args.includes("-v");
  const urlArg = args.find((a) => !a.startsWith("-"));
  const instanceUrl = urlArg || process.env.SERVICENOW_INSTANCE_URL;

  if (!instanceUrl) {
    console.error("Usage: npm run auth [OPTIONS] <SERVICENOW_INSTANCE_URL>");
    console.error("   Or: set SERVICENOW_INSTANCE_URL environment variable");
    console.error("");
    console.error("Options:");
    console.error(
      "  --visible, -v   Force visible browser (skip headless attempt)",
    );
    console.error("");
    console.error("Examples:");
    console.error("  npm run auth https://mycompany.service-now.com");
    console.error(
      "  npm run auth -- --visible https://mycompany.service-now.com",
    );
    process.exit(1);
  }

  // Use robust auth for proper headless→visible fallback
  import("./robust-auth.js")
    .then(async ({ robustAuthenticate }) => {
      // If --visible flag is set, we need a different approach
      if (forceVisible) {
        console.log("🌐 Forced visible browser mode");
        const result = await authenticateViaBrowser(instanceUrl, {
          headless: false,
        });
        process.exit(result.success ? 0 : 1);
      } else {
        // Use robustAuthenticate which has proper headless→visible fallback
        const result = await robustAuthenticate(instanceUrl);
        process.exit(result.success ? 0 : 1);
      }
    })
    .catch((error) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
}
