/**
 * Auto-setup detection and execution
 * Checks if ServiceNow MCP needs initial configuration and runs setup wizard if needed
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
 */
export function autoSetup(): boolean {
  const status = checkSetupNeeded();

  if (!status.needsSetup) {
    return true; // Already configured
  }

  console.error(`⚠️  ${status.reason}`);

  const success = runSetupWizard();

  if (!success) {
    console.error("\n❌ Setup failed. Please run 'npm run setup' manually.\n");
    return false;
  }

  return true;
}
