/**
 * Health Check System
 *
 * Validates all aspects of the ServiceNow MCP authentication setup:
 * - Config file existence and validity
 * - Credentials in system keychain
 * - MFA script functionality
 * - Network connectivity to ServiceNow
 * - Cookie freshness and validity
 *
 * Provides actionable recommendations when issues are found.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "./auth-config.js";
import { CredentialStore } from "./credential-store.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

const CONFIG_DIR = join(homedir(), ".servicenow-mcp");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const COOKIE_FILE = join(CONFIG_DIR, "cookies.json");

export interface CheckResult {
  passed: boolean;
  message: string;
  details?: string[];
  error?: string;
}

export interface HealthCheckResult {
  overall: "healthy" | "degraded" | "unhealthy";
  checks: {
    config: CheckResult;
    credentials: CheckResult;
    mfaScript: CheckResult;
    network: CheckResult;
    cookies: CheckResult;
  };
  recommendations: string[];
}

/**
 * Run all health checks and return comprehensive results
 */
export async function runHealthCheck(): Promise<HealthCheckResult> {
  const checks = {
    config: await checkConfig(),
    credentials: await checkCredentials(),
    mfaScript: await checkMfaScript(),
    network: await checkNetwork(),
    cookies: await checkCookies(),
  };

  // Determine overall health
  const failedChecks = Object.values(checks).filter((c) => !c.passed).length;
  let overall: "healthy" | "degraded" | "unhealthy";

  if (failedChecks === 0) {
    overall = "healthy";
  } else if (failedChecks <= 2) {
    overall = "degraded";
  } else {
    overall = "unhealthy";
  }

  const recommendations = generateRecommendations(checks);

  return {
    overall,
    checks,
    recommendations,
  };
}

/**
 * Check config file existence and validity
 */
async function checkConfig(): Promise<CheckResult> {
  if (!existsSync(CONFIG_FILE)) {
    return {
      passed: false,
      message: "Config file not found",
      error: `Config file does not exist at ${CONFIG_FILE}`,
    };
  }

  try {
    const configManager = new ConfigManager();
    const config = configManager.load();

    if (!config) {
      return {
        passed: false,
        message: "Config file is invalid or empty",
        error: "Could not parse config.json",
      };
    }

    const validation = configManager.validate(config);

    if (!validation.valid) {
      return {
        passed: false,
        message: "Config validation failed",
        details: validation.errors,
      };
    }

    return {
      passed: true,
      message: "Config is valid",
      details: [
        `Instance: ${config.instanceUrl}`,
        `Email: ${config.email}`,
        `MFA Script: ${config.mfaScript}`,
        `Headless: ${config.headless}`,
        `Timeout: ${config.timeout}ms`,
      ],
    };
  } catch (error) {
    return {
      passed: false,
      message: "Config check failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check credentials in system keychain
 */
async function checkCredentials(): Promise<CheckResult> {
  const configManager = new ConfigManager();
  const config = configManager.load();

  if (!config) {
    return {
      passed: false,
      message: "Cannot check credentials without config",
      error: "Config must be set up first",
    };
  }

  try {
    const credentialStore = new CredentialStore();
    const hasPassword = await credentialStore.hasPassword(config.email);

    if (!hasPassword) {
      return {
        passed: false,
        message: "No password found in keychain",
        error: `No password stored for ${config.email}`,
      };
    }

    return {
      passed: true,
      message: "Password found in keychain",
      details: [`Email: ${config.email}`],
    };
  } catch (error) {
    return {
      passed: false,
      message: "Credential check failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check MFA script functionality
 */
async function checkMfaScript(): Promise<CheckResult> {
  const configManager = new ConfigManager();
  const config = configManager.load();

  if (!config) {
    return {
      passed: false,
      message: "Cannot check MFA script without config",
      error: "Config must be set up first",
    };
  }

  const mfaScript = config.mfaScript;

  // Check if file exists
  if (!existsSync(mfaScript)) {
    return {
      passed: false,
      message: "MFA script not found",
      error: `Script does not exist at ${mfaScript}`,
    };
  }

  // Try to execute the script
  try {
    const result = await execFileNoThrow(mfaScript, [], { timeout: 5000 });

    if (result.exitCode !== 0) {
      return {
        passed: false,
        message: "MFA script execution failed",
        error: result.stderr || "Non-zero exit code",
        details: [`Exit code: ${result.exitCode}`, `Script: ${mfaScript}`],
      };
    }

    // Validate that output looks like a TOTP code (6 digits)
    const output = result.stdout.trim();
    if (!/^\d{6}$/.test(output)) {
      return {
        passed: false,
        message: "MFA script output is invalid",
        error: `Expected 6-digit TOTP code, got: ${output}`,
      };
    }

    return {
      passed: true,
      message: "MFA script is functional",
      details: [
        `Script: ${mfaScript}`,
        `Output: ${output} (valid 6-digit code)`,
      ],
    };
  } catch (error) {
    return {
      passed: false,
      message: "MFA script check failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check network connectivity to ServiceNow instance
 */
async function checkNetwork(): Promise<CheckResult> {
  const configManager = new ConfigManager();
  const config = configManager.load();

  if (!config) {
    return {
      passed: false,
      message: "Cannot check network without config",
      error: "Config must be set up first",
    };
  }

  try {
    // Simple HTTP GET to the instance URL
    const url = config.instanceUrl;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual", // Don't follow redirects
    });

    clearTimeout(timeout);

    // We expect a redirect to SSO or 200 OK
    // Status codes 2xx, 3xx indicate the instance is reachable
    if (response.status >= 200 && response.status < 400) {
      return {
        passed: true,
        message: "Network connectivity OK",
        details: [`Instance: ${url}`, `Status: ${response.status}`],
      };
    }

    return {
      passed: false,
      message: "Network connectivity issue",
      error: `Unexpected status code: ${response.status}`,
    };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return {
        passed: false,
        message: "Network request timed out",
        error: `Could not reach ${config.instanceUrl} within 10 seconds`,
      };
    }

    return {
      passed: false,
      message: "Network check failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check cookie freshness and validity
 */
async function checkCookies(): Promise<CheckResult> {
  if (!existsSync(COOKIE_FILE)) {
    return {
      passed: false,
      message: "No cookies found",
      error: `Cookie file does not exist at ${COOKIE_FILE}`,
    };
  }

  try {
    const data = JSON.parse(readFileSync(COOKIE_FILE, "utf-8"));

    if (!data.cookies || !Array.isArray(data.cookies)) {
      return {
        passed: false,
        message: "Cookie file is invalid",
        error: "Missing or invalid cookies array",
      };
    }

    // Check cookie age
    const timestamp = new Date(data.timestamp);
    const ageMinutes = (Date.now() - timestamp.getTime()) / (1000 * 60);
    const ageHours = Math.floor(ageMinutes / 60);
    const remainingMinutes = Math.floor(ageMinutes % 60);

    // ServiceNow sessions typically last 4-8 hours
    // Warn if older than 4 hours, fail if older than 8 hours
    if (ageMinutes > 480) {
      // 8 hours
      return {
        passed: false,
        message: "Cookies are expired",
        error: `Cookies are ${ageHours}h ${remainingMinutes}m old (max: 8 hours)`,
        details: [
          `Captured: ${timestamp.toISOString()}`,
          `Age: ${ageHours}h ${remainingMinutes}m`,
        ],
      };
    }

    const cookieCount = data.cookies.length;
    const hasUserToken = !!data.userToken;

    if (ageMinutes > 240) {
      // 4 hours - warning
      return {
        passed: true,
        message: "Cookies are aging (consider refresh)",
        details: [
          `Captured: ${timestamp.toISOString()}`,
          `Age: ${ageHours}h ${remainingMinutes}m`,
          `Cookie count: ${cookieCount}`,
          `User token: ${hasUserToken ? "present" : "missing"}`,
        ],
      };
    }

    return {
      passed: true,
      message: "Cookies are fresh",
      details: [
        `Captured: ${timestamp.toISOString()}`,
        `Age: ${ageHours}h ${remainingMinutes}m`,
        `Cookie count: ${cookieCount}`,
        `User token: ${hasUserToken ? "present" : "missing"}`,
      ],
    };
  } catch (error) {
    return {
      passed: false,
      message: "Cookie check failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generate actionable recommendations based on check results
 */
function generateRecommendations(checks: {
  config: CheckResult;
  credentials: CheckResult;
  mfaScript: CheckResult;
  network: CheckResult;
  cookies: CheckResult;
}): string[] {
  const recommendations: string[] = [];

  if (!checks.config.passed) {
    recommendations.push("Run 'npm run setup' to configure ServiceNow MCP");
  }

  if (!checks.credentials.passed) {
    recommendations.push(
      "Run 'npm run setup' to store your password in the system keychain",
    );
  }

  if (!checks.mfaScript.passed) {
    recommendations.push(
      "Configure your MFA script path in config.json or verify the script works correctly",
    );
  }

  if (!checks.network.passed) {
    recommendations.push(
      "Check your internet connection and verify the ServiceNow instance URL is correct",
    );
  }

  if (!checks.cookies.passed) {
    if (checks.cookies.error?.includes("does not exist")) {
      recommendations.push(
        "Run 'npm run auth' to authenticate and capture session cookies",
      );
    } else if (checks.cookies.error?.includes("expired")) {
      recommendations.push(
        "Run 'npm run auth' to refresh your session cookies",
      );
    } else {
      recommendations.push(
        "Delete ~/.servicenow-mcp/cookies.json and re-authenticate with 'npm run auth'",
      );
    }
  }

  // If everything passes but cookies are aging
  if (
    checks.config.passed &&
    checks.credentials.passed &&
    checks.mfaScript.passed &&
    checks.network.passed &&
    checks.cookies.passed &&
    checks.cookies.message.includes("aging")
  ) {
    recommendations.push(
      "Consider running 'npm run auth' to refresh session cookies before they expire",
    );
  }

  if (recommendations.length === 0) {
    recommendations.push("Everything looks good! No action needed.");
  }

  return recommendations;
}
