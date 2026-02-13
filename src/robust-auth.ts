/**
 * Robust Authentication Module for Enterprise ServiceNow MCP
 *
 * Features:
 * - Automatic 401 detection and re-authentication
 * - Headless-first with automatic fallback to visible browser
 * - Proper timeouts to prevent hanging
 * - Browser process cleanup
 * - Credential auto-loading from config/keychain
 */

import { firefox, Browser, BrowserContext, Page } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigManager, type AuthConfig } from "./auth-config.js";
import { CredentialStore } from "./credential-store.js";
import { AzureADAutomator } from "./azure-ad-automator.js";
import { Logger } from "./logger.js";

const CONFIG_DIR = join(homedir(), ".servicenow-mcp");
const COOKIE_FILE = join(CONFIG_DIR, "cookies.json");

// Timeouts
const HEADLESS_AUTH_TIMEOUT = 60000; // 60 seconds for headless auth
const VISIBLE_AUTH_TIMEOUT = 300000; // 5 minutes for manual auth
const NAVIGATION_TIMEOUT = 30000; // 30 seconds for page navigation

export interface RobustAuthResult {
  success: boolean;
  cookies?: string;
  userToken?: string;
  instanceUrl?: string;
  error?: string;
  method?: "headless" | "visible" | "cached";
}

/**
 * Load credentials from config and keychain
 */
async function loadCredentials(): Promise<{
  email: string;
  password: string;
  mfaScript: string;
  instanceUrl: string;
  headless: boolean;
} | null> {
  const configManager = new ConfigManager();
  const config = configManager.load();
  if (!config) {
    return null;
  }

  const credentialStore = new CredentialStore();
  const password = await credentialStore.getPassword(config.email);
  if (!password) {
    return null;
  }

  return {
    email: config.email,
    password: password,
    mfaScript: config.mfaScript || "",
    instanceUrl: config.instanceUrl,
    headless: config.headless ?? true,
  };
}

/**
 * Load cached cookies if valid
 */
function loadCachedCookies(): RobustAuthResult | null {
  if (!existsSync(COOKIE_FILE)) {
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(COOKIE_FILE, "utf-8"));
    const timestamp = new Date(data.timestamp);
    const age = Date.now() - timestamp.getTime();
    const maxAge = 8 * 60 * 60 * 1000; // 8 hours

    if (age > maxAge) {
      console.error("⚠️  Cached cookies expired (>8 hours old)");
      return null;
    }

    // Filter to only ServiceNow domain cookies (non-SN cookies cause 401)
    const instanceHost = new URL(data.instanceUrl).hostname;
    const filteredCookies = data.cookies.filter((c: any) => {
      const domain = c.domain || "";
      return (
        domain === instanceHost ||
        domain === `.${instanceHost}` ||
        instanceHost.endsWith(domain.startsWith(".") ? domain : `.${domain}`)
      );
    });

    const cookieString = filteredCookies
      .map((c: any) => `${c.name}=${c.value}`)
      .join("; ");

    return {
      success: true,
      cookies: cookieString,
      userToken: data.userToken || "",
      instanceUrl: data.instanceUrl,
      method: "cached",
    };
  } catch (error) {
    console.error("⚠️  Failed to load cached cookies:", error);
    return null;
  }
}

/**
 * Save cookies to cache
 */
function saveCookies(
  instanceUrl: string,
  cookies: any[],
  userToken?: string,
): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const data = {
    instanceUrl,
    cookies,
    userToken: userToken || "",
    timestamp: new Date().toISOString(),
    source: "robust-auth",
  };

  writeFileSync(COOKIE_FILE, JSON.stringify(data, null, 2));
  console.error(`✅ Cookies saved (${cookies.length} cookies)`);
}

/**
 * Perform authentication with proper timeout and cleanup
 */
async function performAuth(
  instanceUrl: string,
  credentials: { email: string; password: string; mfaScript: string },
  headless: boolean,
  timeout: number,
  logger: Logger,
): Promise<RobustAuthResult> {
  let browser: Browser | null = null;

  try {
    logger.info(
      `Starting ${headless ? "headless" : "visible"} authentication...`,
    );

    browser = await firefox.launch({
      headless,
      timeout: 30000,
      firefoxUserPrefs: {
        "security.default_personal_cert": "Select Automatically",
      },
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // Navigate to ServiceNow
    await page.goto(instanceUrl, {
      waitUntil: "networkidle",
      timeout: NAVIGATION_TIMEOUT,
    });

    // Perform automated login
    const automator = new AzureADAutomator(logger);

    // Wrap in timeout
    const authPromise = automator.performLogin(
      page,
      credentials,
      timeout,
      instanceUrl,
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Authentication timeout")), timeout);
    });

    const result = await Promise.race([authPromise, timeoutPromise]);

    if (result.success && result.cookies) {
      // Wait for ServiceNow page to fully load so g_ck token is available
      // navpage.do uses framesets — g_ck lives inside the gsft_main frame
      try {
        await page.waitForTimeout(3000); // Let frames load
      } catch { /* ignore */ }

      let userToken = "";

      // Try main frame first
      try {
        userToken = await page.evaluate(() => {
          return (window as any).g_ck || (window as any).NOW?.g_ck || "";
        });
      } catch { /* ignore */ }

      // Try sub-frames (navpage.do framesets)
      if (!userToken) {
        try {
          for (const frame of page.frames()) {
            try {
              const token = await frame.evaluate(() => {
                return (window as any).g_ck || (window as any).NOW?.g_ck || "";
              });
              if (token) {
                userToken = token;
                break;
              }
            } catch { /* cross-origin frame, skip */ }
          }
        } catch { /* ignore */ }
      }

      // CRITICAL: Navigate to a REST API endpoint within the browser context
      // to activate the REST API session. SSO creates a UI session, but REST
      // API endpoints may set additional session cookies needed for API access.
      try {
        const apiUrl = `${instanceUrl}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id`;
        logger.info("Activating REST API session via in-browser API call...");
        const apiResult = await page.evaluate(async (url: string) => {
          const resp = await fetch(url, {
            method: "GET",
            credentials: "same-origin",
            headers: { "Accept": "application/json" },
          });
          return { status: resp.status, ok: resp.ok };
        }, apiUrl);
        if (apiResult.ok) {
          logger.info("REST API session activated successfully");
        } else {
          logger.warn(`REST API activation returned status ${apiResult.status}`);
        }
      } catch (e) {
        logger.warn("REST API session activation failed (non-fatal)");
      }

      // Re-capture cookies AFTER the REST API call - this ensures we get
      // any REST-specific session cookies that were set by the API endpoint
      const freshCookies = await context.cookies();
      logger.info(`Re-captured ${freshCookies.length} cookies after REST activation (was ${result.cookies.length})`);

      // Try getting g_ck from the REST API response or cookie
      if (!userToken) {
        // Check for g_ck in the freshly captured cookies
        const gCkCookie = freshCookies.find((c: any) => c.name === "g_ck");
        if (gCkCookie) {
          userToken = gCkCookie.value;
        }
      }

      // Also try to extract g_ck via the session info endpoint
      if (!userToken) {
        try {
          const tokenResult = await page.evaluate(async () => {
            // Try session check endpoint which may return g_ck
            const resp = await fetch("/api/now/ui/user/session_info", {
              method: "GET",
              credentials: "same-origin",
              headers: { "Accept": "application/json" },
            });
            if (resp.ok) {
              const data = await resp.json();
              return data?.result?.g_ck || "";
            }
            return "";
          });
          if (tokenResult) {
            userToken = tokenResult;
            logger.info("g_ck token extracted from session_info API");
          }
        } catch { /* ignore */ }
      }

      // Save the FRESH cookies (after REST API activation)
      saveCookies(instanceUrl, freshCookies, userToken);

      // Format cookies as string
      const cookieString = result.cookies
        .map((c: any) => `${c.name}=${c.value}`)
        .join("; ");

      return {
        success: true,
        cookies: cookieString,
        userToken,
        instanceUrl,
        method: headless ? "headless" : "visible",
      };
    } else {
      return {
        success: false,
        error: result.error || "Authentication failed",
      };
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message || "Unknown authentication error",
    };
  } finally {
    // Always clean up browser
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Main robust authentication function
 *
 * 1. Try cached cookies first
 * 2. Try headless authentication
 * 3. Fall back to visible browser if headless fails
 */
export async function robustAuthenticate(
  instanceUrl?: string,
): Promise<RobustAuthResult> {
  const logger = new Logger("INFO");

  // Step 1: Load credentials
  const creds = await loadCredentials();
  if (!creds) {
    return {
      success: false,
      error: "No credentials configured. Run 'npm run setup' first.",
    };
  }

  const targetUrl = instanceUrl || creds.instanceUrl;
  logger.info(`🔐 Authenticating to ${targetUrl}`);

  // Step 2: Try cached cookies
  const cached = loadCachedCookies();
  if (cached && cached.success) {
    logger.info("✅ Using cached cookies");
    return cached;
  }

  // Step 3: Try headless authentication
  logger.info("🔄 Attempting headless authentication...");
  const headlessResult = await performAuth(
    targetUrl,
    creds,
    true, // headless
    HEADLESS_AUTH_TIMEOUT,
    logger,
  );

  if (headlessResult.success) {
    logger.info("✅ Headless authentication successful!");
    return headlessResult;
  }

  logger.warn(`⚠️  Headless auth failed: ${headlessResult.error}`);

  // Step 4: Fall back to visible browser
  logger.info("🌐 Opening visible browser for manual authentication...");
  const visibleResult = await performAuth(
    targetUrl,
    creds,
    false, // visible
    VISIBLE_AUTH_TIMEOUT,
    logger,
  );

  if (visibleResult.success) {
    logger.info("✅ Visible browser authentication successful!");
    return visibleResult;
  }

  return {
    success: false,
    error: `Authentication failed. Headless: ${headlessResult.error}. Visible: ${visibleResult.error}`,
  };
}

/**
 * Handle 401 error by re-authenticating
 * Returns fresh cookies on success
 */
export async function handleAuthFailure(): Promise<RobustAuthResult> {
  console.error("\n⚠️  401 Unauthorized - Re-authenticating...\n");

  // Clear cached cookies to force re-auth
  if (existsSync(COOKIE_FILE)) {
    try {
      const fs = await import("node:fs");
      fs.unlinkSync(COOKIE_FILE);
    } catch {
      // Ignore delete errors
    }
  }

  return robustAuthenticate();
}

/**
 * Validate current session by making a test request
 */
export async function validateSession(
  instanceUrl: string,
  cookies: string,
  userToken?: string,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      Cookie: cookies,
      Accept: "application/json",
    };
    if (userToken) {
      headers["x-usertoken"] = userToken;
    }
    const response = await fetch(
      `${instanceUrl}/api/now/table/sys_user?sysparm_limit=1`,
      { headers },
    );
    return response.status === 200;
  } catch {
    return false;
  }
}
