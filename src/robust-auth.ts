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

    // Format cookies as string
    const cookieString = data.cookies
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
      // Extract user token from page if possible
      let userToken = "";
      try {
        userToken = await page.evaluate(() => {
          return (window as any).g_ck || (window as any).NOW?.g_ck || "";
        });
      } catch {
        // Ignore token extraction errors
      }

      // Save cookies
      saveCookies(instanceUrl, result.cookies, userToken);

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
): Promise<boolean> {
  try {
    const response = await fetch(
      `${instanceUrl}/api/now/table/sys_user?sysparm_limit=1`,
      {
        headers: {
          Cookie: cookies,
          Accept: "application/json",
        },
      },
    );
    return response.status === 200;
  } catch {
    return false;
  }
}
