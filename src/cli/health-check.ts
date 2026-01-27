#!/usr/bin/env node
/**
 * Health Check CLI
 *
 * Command-line interface for running health checks on the
 * ServiceNow MCP authentication setup.
 *
 * Usage: npm run test-auth
 */

import chalk from "chalk";
import { runHealthCheck } from "../health-check.js";
import type { CheckResult } from "../health-check.js";

/**
 * Format a check result with color-coded status
 */
function formatCheck(name: string, result: CheckResult): string {
  const statusIcon = result.passed ? chalk.green("✅") : chalk.red("❌");
  const statusText = result.passed ? chalk.green("PASS") : chalk.red("FAIL");

  let output = `${statusIcon} ${chalk.bold(name)}: ${statusText} - ${result.message}\n`;

  if (result.details && result.details.length > 0) {
    for (const detail of result.details) {
      output += chalk.gray(`   ${detail}\n`);
    }
  }

  if (result.error) {
    output += chalk.red(`   Error: ${result.error}\n`);
  }

  return output;
}

/**
 * Main CLI entry point
 */
async function main() {
  console.log(chalk.bold("\n🏥 ServiceNow MCP Health Check\n"));

  const healthCheck = await runHealthCheck();

  // Display individual check results
  console.log(formatCheck("Config", healthCheck.checks.config));
  console.log(formatCheck("Credentials", healthCheck.checks.credentials));
  console.log(formatCheck("MFA Script", healthCheck.checks.mfaScript));
  console.log(formatCheck("Network", healthCheck.checks.network));
  console.log(formatCheck("Cookies", healthCheck.checks.cookies));

  // Display overall health status
  console.log(chalk.bold("\n📊 Overall Health:"));
  if (healthCheck.overall === "healthy") {
    console.log(chalk.green(`   ${healthCheck.overall.toUpperCase()} ✅\n`));
  } else if (healthCheck.overall === "degraded") {
    console.log(chalk.yellow(`   ${healthCheck.overall.toUpperCase()} ⚠️\n`));
  } else {
    console.log(chalk.red(`   ${healthCheck.overall.toUpperCase()} ❌\n`));
  }

  // Display recommendations
  if (healthCheck.recommendations.length > 0) {
    console.log(chalk.bold("💡 Recommendations:\n"));
    for (const recommendation of healthCheck.recommendations) {
      console.log(chalk.cyan(`   • ${recommendation}`));
    }
    console.log("");
  }

  // Exit with appropriate code
  process.exit(healthCheck.overall === "healthy" ? 0 : 1);
}

main().catch((error) => {
  console.error(chalk.red("\n❌ Health check failed:"), error);
  process.exit(1);
});
