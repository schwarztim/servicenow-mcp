import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LogLevel } from "./logger.js";

const CONFIG_DIR = join(homedir(), ".servicenow-mcp");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface AuthConfig {
  instanceUrl: string;
  email: string;
  mfaScript: string;
  headless: boolean;
  timeout: number;
  retryAttempts: number;
  logLevel: LogLevel;
}

export const DEFAULT_CONFIG: Partial<AuthConfig> = {
  mfaScript: join(homedir(), ".claude/scripts/totp-gen.sh"),
  headless: true,
  timeout: 90000,
  retryAttempts: 3,
  logLevel: "INFO",
};

export class ConfigManager {
  /**
   * Load configuration from file or return defaults
   */
  load(): AuthConfig | null {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }

    try {
      const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      return { ...DEFAULT_CONFIG, ...data } as AuthConfig;
    } catch (error) {
      console.error(`Failed to parse config: ${error}`);
      return null;
    }
  }

  /**
   * Save configuration to file
   */
  save(config: AuthConfig): void {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }

  /**
   * Validate configuration completeness
   */
  validate(config: AuthConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config.instanceUrl) {
      errors.push("Missing instanceUrl");
    } else if (!config.instanceUrl.startsWith("https://")) {
      errors.push("instanceUrl must start with https://");
    }

    if (!config.email) {
      errors.push("Missing email");
    } else if (!config.email.includes("@")) {
      errors.push("Invalid email format");
    }

    if (!config.mfaScript) {
      errors.push("Missing mfaScript path");
    }

    if (config.timeout < 10000 || config.timeout > 300000) {
      errors.push("timeout must be between 10000ms and 300000ms");
    }

    if (config.retryAttempts < 1 || config.retryAttempts > 5) {
      errors.push("retryAttempts must be between 1 and 5");
    }

    return { valid: errors.length === 0, errors };
  }
}
