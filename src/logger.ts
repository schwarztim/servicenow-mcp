import winston from "winston";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_DIR = join(homedir(), ".servicenow-mcp", "logs");

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

export class Logger {
  private logger: winston.Logger;

  constructor(level: LogLevel = "INFO") {
    const logFile = join(LOG_DIR, `auth-${this.getDateString()}.log`);

    this.logger = winston.createLogger({
      level: level.toLowerCase(),
      format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.printf(
          ({ timestamp, level, message }) =>
            `${timestamp} [${level.toUpperCase()}] ${message}`,
        ),
      ),
      transports: [
        new winston.transports.File({ filename: logFile }),
        new winston.transports.Console({
          format: winston.format.simple(),
        }),
      ],
    });
  }

  private getDateString(): string {
    return new Date().toISOString().split("T")[0];
  }

  /**
   * Sanitize sensitive data before logging
   */
  private sanitize(data: any): any {
    if (typeof data === "string") {
      // Mask emails: user@example.com -> t***@example.com
      data = data.replace(/([a-zA-Z])[a-zA-Z0-9._-]+@/, "$1***@");
      // Mask TOTP codes: 123456 -> 123***
      data = data.replace(/\b(\d{3})\d{3}\b/g, "$1***");
      // Mask passwords: password -> ***
      if (data.toLowerCase().includes("password")) {
        data = data.replace(/password[=:]\s*\S+/gi, "password: ***");
      }
    }
    return data;
  }

  debug(message: string, meta?: object): void {
    this.logger.debug(this.sanitize(message), meta);
  }

  info(message: string, meta?: object): void {
    this.logger.info(this.sanitize(message), meta);
  }

  warn(message: string, meta?: object): void {
    this.logger.warn(this.sanitize(message), meta);
  }

  error(message: string, error?: Error): void {
    const sanitizedMessage = this.sanitize(message);
    if (error) {
      this.logger.error(sanitizedMessage, {
        error: error.message,
        stack: error.stack,
      });
    } else {
      this.logger.error(sanitizedMessage);
    }
  }
}
