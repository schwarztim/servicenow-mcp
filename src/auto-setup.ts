/**
 * Auto-setup detection and execution
 * Checks if ServiceNow MCP needs initial configuration and runs setup wizard if needed
 * For expired cookies, attempts silent background re-authentication first
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CredentialStore } from "./credential-store.js";
import { ConfigManager } from "./auth-config.js";
import { authenticateViaBrowser } from "./auth-browser.js";

const CONFIG_DIR = join(homedir(), ".servicenow-mcp");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const COOKIE_FILE = join(CONFIG_DIR, "cookies.json");

export interface SetupStatus {
  needsSetup: boolean;
  reason?: string;
  hasConfig: boolean;
  hasCookies: boolean;
  cookiesExpired: boolean;
}

/**
 * Check if setup is needed
 */
export function checkSetupNeeded(): SetupStatus {
  const hasConfig = existsSync(CONFIG_FILE);
  const hasCookies = existsSync(COOKIE_FILE);

  if (!hasConfig) {
    return {
      needsSetup: true,
      reason: "No configuration found",
      hasConfig: false,
      hasCookies: false,
      cookiesExpired: false,
    };
  }

  if (!hasCookies) {
    return {
      needsSetup: true,
      reason: "No authentication cookies found",
      hasConfig: true,
      hasCookies: false,
      cookiesExpired: false,
    };
  }

  // Check if cookies are expired (older than 8 hours)
  try {
    const cookieData = JSON.parse(readFileSync(COOKIE_FILE, "utf-8"));
    const timestamp = new Date(cookieData.timestamp);
    const age = Date.now() - timestamp.getTime();
    const eightHours = 8 * 60 * 60 * 1000;

    if (age > eightHours) {
      return {
        needsSetup: true,
        reason: "Authentication cookies expired (>8 hours old)",
        hasConfig: true,
        hasCookies: true,
        cookiesExpired: true,
      };
    }
  } catch (error) {
    return {
      needsSetup: true,
      reason: "Invalid cookie file",
      hasConfig: true,
      hasCookies: true,
      cookiesExpired: false,
    };
  }

  return {
    needsSetup: false,
    hasConfig: true,
    hasCookies: true,
    cookiesExpired: false,
  };
}

/**
 * Attempt background re-authentication using stored credentials
 * Returns true if successful, false otherwise
 */
async function runBackgroundAuth(): Promise<boolean> {
  console.error("\n🔄 Attempting background re-authentication...\n");

  try {
    // Load existing configuration
    const configManager = new ConfigManager();
    const config = configManager.load();
    if (!config) {
      console.error("❌ No configuration found");
      return false;
    }

    // Load password from keychain
    const credentialStore = new CredentialStore();
    const password = await credentialStore.getPassword(config.email);
    if (!password) {
      console.error("❌ No password found in keychain");
      return false;
    }

    // Attempt headless authentication
    const result = await authenticateViaBrowser(config.instanceUrl, {
      email: config.email,
      password: password,
      mfaScript: config.mfaScript || "",
      headless: true, // Always headless for background re-auth
      config: config,
    });

    if (result.success) {
      console.error("✅ Background re-authentication successful\n");
      return true;
    } else {
      console.error(
        `❌ Background re-authentication failed: ${result.error}\n`,
      );
      return false;
    }
  } catch (error: any) {
    console.error(`❌ Background re-authentication error: ${error.message}\n`);
    return false;
  }
}

/**
 * Run setup wizard (blocking)
 * This spawns the setup CLI as a child process
 */
export function runSetupWizard(): boolean {
  console.error("\n🔧 ServiceNow MCP requires initial setup...\n");

  const result = spawnSync("npm", ["run", "setup"], {
    stdio: "inherit",
    shell: true,
  });

  return result.status === 0;
}

/**
 * Auto-setup: Check if setup is needed and run it if necessary
 * Returns true if ready to proceed, false if setup failed
 * For expired cookies, attempts background re-auth first before falling back to wizard
 */
export async function autoSetup(): Promise<boolean> {
  // Auth is handled lazily by src/auth.ts (keychain + headless Playwright).
  // No pre-flight checks needed — getAuthHeaders() runs on first API call.
  return true;
}
