#!/usr/bin/env node

import prompts from "prompts";
import chalk from "chalk";
import ora from "ora";
import { existsSync } from "node:fs";
import { CredentialStore } from "../credential-store.js";
import { ConfigManager, DEFAULT_CONFIG } from "../auth-config.js";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import { firefox } from "playwright";
import { AzureADAutomator } from "../azure-ad-automator.js";
import { Logger } from "../logger.js";

/**
 * Interactive Setup Wizard for ServiceNow MCP
 *
 * Guides users through first-time configuration:
 * 1. Prompts for instance URL, email, password
 * 2. Stores credentials securely in system keychain
 * 3. Prompts for MFA script path
 * 4. Tests MFA script execution
 * 5. Saves configuration
 * 6. Tests full authentication flow
 */

interface SetupConfig {
  instanceUrl: string;
  email: string;
  password: string;
  mfaScript: string;
}

async function main() {
  console.log(chalk.bold.blue("\n🔧 ServiceNow MCP Setup Wizard\n"));
  console.log(
    chalk.dim(
      "This wizard will guide you through the initial configuration.\n",
    ),
  );

  const credentialStore = new CredentialStore();
  const configManager = new ConfigManager();

  // Check if already configured
  const existingConfig = configManager.load();
  if (existingConfig) {
    const { confirmReconfigure } = await prompts({
      type: "confirm",
      name: "confirmReconfigure",
      message: "Configuration already exists. Do you want to reconfigure?",
      initial: false,
    });

    if (!confirmReconfigure) {
      console.log(
        chalk.yellow("\nSetup cancelled. Existing configuration preserved.\n"),
      );
      process.exit(0);
    }
  }

  // Step 1: Prompt for ServiceNow instance URL
  const { instanceUrl } = await prompts({
    type: "text",
    name: "instanceUrl",
    message:
      "ServiceNow instance URL (e.g., https://dev12345.service-now.com):",
    validate: (value) => {
      if (!value) return "Instance URL is required";
      if (!value.startsWith("https://")) {
        return "Instance URL must start with https://";
      }
      if (!value.includes("service-now.com")) {
        return "Instance URL must contain service-now.com";
      }
      return true;
    },
  });

  if (!instanceUrl) {
    console.log(chalk.red("\n❌ Setup cancelled. Instance URL is required.\n"));
    process.exit(1);
  }

  // Step 2: Prompt for email
  const { email } = await prompts({
    type: "text",
    name: "email",
    message: "Your email address:",
    validate: (value) => {
      if (!value) return "Email is required";
      if (!value.includes("@")) return "Invalid email format";
      return true;
    },
  });

  if (!email) {
    console.log(chalk.red("\n❌ Setup cancelled. Email is required.\n"));
    process.exit(1);
  }

  // Step 3: Prompt for password (hidden input)
  const { password } = await prompts({
    type: "password",
    name: "password",
    message: "Your password:",
    validate: (value) => {
      if (!value) return "Password is required";
      if (value.length < 8) return "Password must be at least 8 characters";
      return true;
    },
  });

  if (!password) {
    console.log(chalk.red("\n❌ Setup cancelled. Password is required.\n"));
    process.exit(1);
  }

  // Step 4: Store credentials in keychain
  const storeSpinner = ora("Storing credentials in system keychain").start();
  try {
    await credentialStore.setPassword(email, password);
    storeSpinner.succeed(
      chalk.green("Credentials stored securely in keychain"),
    );
  } catch (error: any) {
    storeSpinner.fail(chalk.red("Failed to store credentials"));
    console.error(chalk.red(`Error: ${error.message}\n`));
    process.exit(1);
  }

  // Step 5: Prompt for MFA script path
  const { mfaScript } = await prompts({
    type: "text",
    name: "mfaScript",
    message: "Path to MFA TOTP script:",
    initial: DEFAULT_CONFIG.mfaScript,
    validate: (value) => {
      if (!value) return "MFA script path is required";
      if (!existsSync(value)) {
        return `File not found: ${value}`;
      }
      return true;
    },
  });

  if (!mfaScript) {
    console.log(
      chalk.red("\n❌ Setup cancelled. MFA script path is required.\n"),
    );
    process.exit(1);
  }

  // Step 6: Test MFA script execution
  const mfaTestSpinner = ora("Testing MFA script execution").start();
  try {
    const result = await execFileNoThrow(mfaScript, [], { timeout: 10000 });

    if (result.exitCode !== 0) {
      mfaTestSpinner.fail(chalk.red("MFA script execution failed"));
      console.error(chalk.red(`Error: ${result.stderr || "Unknown error"}\n`));
      console.log(
        chalk.yellow(
          "Please ensure your MFA script is executable and outputs a 6-digit TOTP code.\n",
        ),
      );
      process.exit(1);
    }

    const mfaCode = result.stdout.trim();
    if (!/^\d{6}$/.test(mfaCode)) {
      mfaTestSpinner.fail(chalk.red("Invalid MFA code format"));
      console.error(
        chalk.red(
          `Expected 6-digit code, got: ${mfaCode.length > 0 ? mfaCode : "(empty)"}\n`,
        ),
      );
      console.log(
        chalk.yellow(
          "Your MFA script must output exactly a 6-digit TOTP code (e.g., 123456).\n",
        ),
      );
      process.exit(1);
    }

    mfaTestSpinner.succeed(
      chalk.green(`MFA script working correctly (generated: ${mfaCode})`),
    );
  } catch (error: any) {
    mfaTestSpinner.fail(chalk.red("Failed to test MFA script"));
    console.error(chalk.red(`Error: ${error.message}\n`));
    process.exit(1);
  }

  // Step 7: Save configuration
  const saveSpinner = ora("Saving configuration").start();
  try {
    const config = {
      instanceUrl,
      email,
      mfaScript,
      headless: DEFAULT_CONFIG.headless!,
      timeout: DEFAULT_CONFIG.timeout!,
      retryAttempts: DEFAULT_CONFIG.retryAttempts!,
      logLevel: DEFAULT_CONFIG.logLevel!,
    };

    configManager.save(config);
    saveSpinner.succeed(chalk.green("Configuration saved successfully"));
  } catch (error: any) {
    saveSpinner.fail(chalk.red("Failed to save configuration"));
    console.error(chalk.red(`Error: ${error.message}\n`));
    process.exit(1);
  }

  // Step 8: Ask if user wants to test authentication now
  console.log();
  const { testAuth } = await prompts({
    type: "confirm",
    name: "testAuth",
    message: "Would you like to test the authentication flow now?",
    initial: true,
  });

  if (testAuth) {
    console.log();
    const testSpinner = ora("Testing full authentication flow").start();

    try {
      const logger = new Logger("INFO");
      const browser = await firefox.launch({
        headless: false, // Show browser for first test
      });

      const context = await browser.newContext();
      const page = await context.newPage();

      // Navigate to ServiceNow instance
      await page.goto(instanceUrl, { waitUntil: "networkidle", timeout: 60000 });

      // Perform Azure AD login
      const automator = new AzureADAutomator(logger);
      const result = await automator.performLogin(
        page,
        { email, password, mfaScript },
        90000,
        instanceUrl,
      );

      await browser.close();

      if (result.success) {
        testSpinner.succeed(chalk.green("Authentication test successful!"));
        console.log(
          chalk.green("\n✅ Setup complete! Your configuration is working.\n"),
        );
      } else {
        testSpinner.fail(chalk.red("Authentication test failed"));
        console.error(chalk.red(`Error: ${result.error}\n`));
        console.log(
          chalk.yellow(
            "Configuration saved, but authentication failed. Please check your credentials and try again.\n",
          ),
        );
        process.exit(1);
      }
    } catch (error: any) {
      testSpinner.fail(chalk.red("Authentication test failed"));
      console.error(chalk.red(`Error: ${error.message}\n`));
      console.log(
        chalk.yellow(
          "Configuration saved, but authentication test failed. You can test manually later.\n",
        ),
      );
      process.exit(1);
    }
  } else {
    console.log(chalk.green("\n✅ Setup complete!\n"));
  }

  // Display next steps
  console.log(chalk.bold.blue("Next Steps:\n"));
  console.log(
    chalk.dim("1. Add the MCP server to your Claude Desktop configuration:"),
  );
  console.log(
    chalk.cyan(
      `   "${instanceUrl.replace("https://", "").split(".")[0]}-mcp": {`,
    ),
  );
  console.log(chalk.cyan('     "command": "node",'));
  console.log(chalk.cyan(`     "args": ["${process.cwd()}/dist/index.js"]`));
  console.log(chalk.cyan("   }\n"));
  console.log(chalk.dim("2. Restart Claude Desktop to load the MCP server"));
  console.log(
    chalk.dim("3. Test by asking Claude to interact with ServiceNow\n"),
  );
}

// Run the setup wizard
main().catch((error) => {
  console.error(chalk.red(`\n❌ Setup failed: ${error.message}\n`));
  process.exit(1);
});
