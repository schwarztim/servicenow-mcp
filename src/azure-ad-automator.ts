import type { Page } from "playwright";
import { Logger } from "./logger.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

/**
 * Multi-selector patterns for Azure AD login flow.
 * Each field type has multiple possible selectors for resilience.
 */
const SELECTORS = {
  email: [
    'input[type="email"]',
    'input[name="loginfmt"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
    "#i0116",
  ],
  emailNext: [
    'input[type="submit"][value="Next"]',
    'button:has-text("Next")',
    "#idSIButton9",
  ],
  password: [
    'input[type="password"]',
    'input[name="passwd"]',
    'input[placeholder*="password" i]',
    "#i0118",
  ],
  passwordNext: [
    'input[type="submit"][value="Sign in"]',
    'button:has-text("Sign in")',
    "#idSIButton9",
  ],
  mfaCode: [
    'input[name="otc"]',
    'input[type="tel"]',
    'input[placeholder*="code" i]',
    "#idTxtBx_SAOTCC_OTC",
  ],
  mfaVerify: [
    'input[type="submit"][value="Verify"]',
    'button:has-text("Verify")',
    "#idSubmit_SAOTCC_Continue",
  ],
  // Push MFA detection - these indicate waiting for Authenticator approval
  mfaPushPrompt: [
    'div:has-text("Approve sign in request")',
    'div:has-text("Open your Authenticator app")',
    'div:has-text("We\'ve sent a notification")',
    'div:has-text("Approve the request")',
    'div:has-text("Check your phone")',
    "#idDiv_SAOTCAS_Title", // Azure AD push notification title div
    "#idRichContext_DisplaySign", // Number matching display
  ],
  // Phone call MFA detection
  mfaPhoneCall: [
    'div:has-text("We\'re calling")',
    'div:has-text("Answer the call")',
    'div:has-text("Press #")',
  ],
  staySignedIn: [
    'input[type="submit"][value="Yes"]',
    'button:has-text("Yes")',
    "#idSIButton9",
  ],
  staySignedInNo: ['input[type="submit"][value="No"]', 'button:has-text("No")'],
} as const;

export interface LoginCredentials {
  email: string;
  password: string;
  mfaScript: string;
}

export interface LoginResult {
  success: boolean;
  error?: string;
  cookies?: any[];
  requiresManualMfa?: boolean; // True when push/phone MFA detected (needs visible browser)
}

export class AzureADAutomator {
  private logger: Logger;
  private instanceUrl: string | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Main orchestration: perform complete Azure AD login
   */
  async performLogin(
    page: Page,
    credentials: LoginCredentials,
    timeout: number = 90000,
    instanceUrl?: string,
  ): Promise<LoginResult> {
    this.instanceUrl = instanceUrl || null;
    try {
      this.logger.info("Starting Azure AD login automation");

      // Step 1: Email field
      const emailFilled = await this.detectAndFillEmail(
        page,
        credentials.email,
        timeout,
      );
      if (!emailFilled) {
        return {
          success: false,
          error: "Failed to detect or fill email field",
        };
      }

      // Step 2: Password field (may appear after email or on same page)
      await page.waitForTimeout(1000);
      const passwordFilled = await this.detectAndFillPassword(
        page,
        credentials.password,
        timeout,
      );
      if (!passwordFilled) {
        return {
          success: false,
          error: "Failed to detect or fill password field",
        };
      }

      // Step 3: MFA code (may or may not appear)
      await page.waitForTimeout(1000);

      // Quick check: if we're already on ServiceNow after password, skip MFA
      if (this.isServiceNowUrl(page.url())) {
        this.logger.info("Already on ServiceNow after password - no MFA needed");
        const cookies = await page.context().cookies();
        this.logger.info("Azure AD login completed successfully");
        return { success: true, cookies };
      }

      const mfaResult = await this.detectAndFillMFA(
        page,
        credentials.mfaScript,
        timeout,
      );

      // Handle push MFA - requires visible browser for user to approve
      if (mfaResult === "push_mfa_detected") {
        return {
          success: false,
          error:
            "Push MFA detected - requires visible browser for manual approval",
          requiresManualMfa: true,
        };
      }

      if (!mfaResult) {
        this.logger.warn("MFA handling failed");
      }

      // Step 4: Handle "Stay signed in?" prompt
      await page.waitForTimeout(1000);

      // Quick check: if we're already on ServiceNow, skip "Stay signed in?"
      if (this.isServiceNowUrl(page.url())) {
        this.logger.info("Already on ServiceNow - skipping stay signed in check");
        const cookies = await page.context().cookies();
        this.logger.info("Azure AD login completed successfully");
        return { success: true, cookies };
      }

      await this.handleStaySignedIn(page, timeout);

      // Step 5: Wait for ServiceNow redirect
      const redirected = await this.waitForServiceNowRedirect(page, timeout);
      if (!redirected) {
        return {
          success: false,
          error: "Timeout waiting for ServiceNow redirect",
        };
      }

      // Extract cookies for session persistence
      const cookies = await page.context().cookies();

      this.logger.info("Azure AD login completed successfully");
      return { success: true, cookies };
    } catch (error: any) {
      this.logger.error("Azure AD login failed", error);
      return {
        success: false,
        error: error.message || "Unknown error during login",
      };
    }
  }

  /**
   * Try multiple selectors with retries until one works
   */
  private async trySelectors(
    page: Page,
    selectors: readonly string[],
    timeout: number,
    action?: "click" | "fill",
    fillValue?: string,
  ): Promise<boolean> {
    for (const selector of selectors) {
      try {
        this.logger.debug(`Trying selector: ${selector}`);
        const element = await page.waitForSelector(selector, {
          timeout: Math.min(timeout, 5000),
          state: "visible",
        });

        if (element) {
          if (action === "click") {
            await element.click();
            this.logger.debug(`Clicked element: ${selector}`);
          } else if (action === "fill" && fillValue !== undefined) {
            await element.fill(fillValue);
            this.logger.debug(`Filled element: ${selector}`);
          }
          return true;
        }
      } catch (error) {
        // Selector failed, try next one
        this.logger.debug(`Selector failed: ${selector}`);
        continue;
      }
    }

    return false;
  }

  /**
   * Detect and fill email field, then click Next
   */
  private async detectAndFillEmail(
    page: Page,
    email: string,
    timeout: number,
  ): Promise<boolean> {
    this.logger.info("Detecting email field");

    // Fill email
    const emailFilled = await this.trySelectors(
      page,
      SELECTORS.email,
      timeout,
      "fill",
      email,
    );
    if (!emailFilled) {
      this.logger.error("No email field detected");
      return false;
    }

    this.logger.info("Email field filled");
    await page.waitForTimeout(500);

    // Click Next button
    const nextClicked = await this.trySelectors(
      page,
      SELECTORS.emailNext,
      timeout,
      "click",
    );
    if (!nextClicked) {
      this.logger.warn("No email Next button found (combined flow?)");
      // In combined flow, no Next button after email
      return true;
    }

    this.logger.info("Email Next button clicked");
    return true;
  }

  /**
   * Detect and fill password field, then click Sign in
   */
  private async detectAndFillPassword(
    page: Page,
    password: string,
    timeout: number,
  ): Promise<boolean> {
    this.logger.info("Detecting password field");

    // Fill password
    const passwordFilled = await this.trySelectors(
      page,
      SELECTORS.password,
      timeout,
      "fill",
      password,
    );
    if (!passwordFilled) {
      this.logger.error("No password field detected");
      return false;
    }

    this.logger.info("Password field filled");
    await page.waitForTimeout(500);

    // Click Sign in button
    const signinClicked = await this.trySelectors(
      page,
      SELECTORS.passwordNext,
      timeout,
      "click",
    );
    if (!signinClicked) {
      this.logger.error("No Sign in button detected");
      return false;
    }

    this.logger.info("Sign in button clicked");
    return true;
  }

  /**
   * Detect MFA field, generate code via script, and submit
   * Also detects push-based MFA that requires manual approval
   */
  private async detectAndFillMFA(
    page: Page,
    mfaScript: string,
    timeout: number,
  ): Promise<boolean | "push_mfa_detected"> {
    this.logger.info("Checking for MFA prompts");

    // Quick check: if we're already on ServiceNow, skip MFA entirely
    if (this.isServiceNowUrl(page.url())) {
      this.logger.info("Already on ServiceNow - MFA not needed");
      return true;
    }

    // First, check for push MFA prompts (Authenticator app, phone call)
    // These require user interaction and can't be automated
    const pushMfaDetected = await this.detectPushMfa(page);
    if (pushMfaDetected) {
      this.logger.warn(
        "⚠️  Push/phone MFA detected - requires manual approval!",
      );
      this.logger.warn(
        "   Please check your Microsoft Authenticator app or phone",
      );
      return "push_mfa_detected"; // Signal that we need visible browser
    }

    // Check if TOTP code input field exists (may not be required)
    // Use 3s timeout — if MFA field hasn't appeared by now, it won't
    const mfaFieldExists = await this.trySelectors(
      page,
      SELECTORS.mfaCode,
      Math.min(timeout, 3000),
    );

    if (!mfaFieldExists) {
      this.logger.info("No MFA field detected (may not be required)");
      return true; // Not an error, MFA may not be required
    }

    // If MFA field exists but no script configured, user must enter manually
    if (!mfaScript || mfaScript.trim() === "") {
      this.logger.warn(
        "MFA field detected but no MFA script configured - manual entry required",
      );
      this.logger.warn("Waiting for manual MFA code entry...");
      return true; // Return true to allow manual entry (browser stays open)
    }

    this.logger.info("MFA field detected, generating code");

    // Generate MFA code securely via execFileNoThrow
    const result = await execFileNoThrow(mfaScript, [], { timeout: 10000 });

    if (result.exitCode !== 0) {
      this.logger.error(
        `MFA script failed: ${result.stderr || "Unknown error"}`,
      );
      return false;
    }

    const mfaCode = result.stdout.trim();
    if (!/^\d{6}$/.test(mfaCode)) {
      this.logger.error(`Invalid MFA code format: ${mfaCode}`);
      return false;
    }

    this.logger.info("MFA code generated successfully");

    // Fill MFA code
    const mfaFilled = await this.trySelectors(
      page,
      SELECTORS.mfaCode,
      timeout,
      "fill",
      mfaCode,
    );
    if (!mfaFilled) {
      this.logger.error("Failed to fill MFA code");
      return false;
    }

    this.logger.info("MFA code filled");
    await page.waitForTimeout(500);

    // Click Verify button
    const verifyClicked = await this.trySelectors(
      page,
      SELECTORS.mfaVerify,
      timeout,
      "click",
    );
    if (!verifyClicked) {
      this.logger.error("No Verify button detected");
      return false;
    }

    this.logger.info("MFA Verify button clicked");
    return true;
  }

  /**
   * Detect push-based MFA prompts (Authenticator app, phone call)
   * These cannot be automated and require manual user interaction
   * NOTE: Uses fast timeouts (500ms) to avoid burning 30+ seconds when no MFA prompt exists
   */
  private async detectPushMfa(page: Page): Promise<boolean> {
    // Quick check: if we're already on ServiceNow, skip MFA detection entirely
    if (this.isServiceNowUrl(page.url())) {
      this.logger.info("Already on ServiceNow - skipping MFA detection");
      return false;
    }

    // Fast content check first (single call, no selector waiting)
    try {
      const pageContent = await page.content();
      const pushMfaPatterns = [
        /approve.*sign.*in.*request/i,
        /open.*authenticator.*app/i,
        /sent.*notification/i,
        /check.*your.*phone/i,
        /we're.*calling/i,
        /answer.*call/i,
        /enter.*the.*number.*shown/i, // Number matching
      ];

      for (const pattern of pushMfaPatterns) {
        if (pattern.test(pageContent)) {
          this.logger.debug(`Push MFA detected via page content: ${pattern}`);
          return true;
        }
      }
    } catch {
      // Ignore content check errors
    }

    // Quick selector check with 500ms timeout per selector (not 3s)
    const allPushSelectors = [
      ...SELECTORS.mfaPushPrompt,
      ...SELECTORS.mfaPhoneCall,
    ];
    for (const selector of allPushSelectors) {
      try {
        const element = await page.waitForSelector(selector, {
          timeout: 500,
          state: "visible",
        });
        if (element) {
          this.logger.debug(`Push MFA detected via: ${selector}`);
          return true;
        }
      } catch {
        // Selector not found, continue
      }
    }

    return false;
  }

  /**
   * Handle "Stay signed in?" prompt (click Yes by default)
   */
  private async handleStaySignedIn(
    page: Page,
    timeout: number,
  ): Promise<boolean> {
    this.logger.info("Checking for 'Stay signed in?' prompt");

    // Quick check: if we're already on ServiceNow, skip
    if (this.isServiceNowUrl(page.url())) {
      this.logger.info("Already on ServiceNow - skipping 'Stay signed in?' check");
      return true;
    }

    // Try to click the Yes button directly with a reasonable timeout
    // If it's not there, that's fine - the prompt may not appear
    const yesClicked = await this.trySelectorsWithTimeout(
      page,
      SELECTORS.staySignedIn,
      5000, // 5 seconds - fast detection
      "click",
    );

    if (!yesClicked) {
      this.logger.info("No 'Stay signed in?' prompt detected");
      return true; // Not an error, prompt may not appear
    }

    this.logger.info("'Stay signed in?' Yes button clicked");
    return true;
  }

  /**
   * Try selectors with a custom per-selector timeout (not capped at 5s)
   */
  private async trySelectorsWithTimeout(
    page: Page,
    selectors: readonly string[],
    timeoutPerSelector: number,
    action?: "click" | "fill",
    fillValue?: string,
  ): Promise<boolean> {
    for (const selector of selectors) {
      try {
        this.logger.debug(`Trying selector: ${selector}`);
        const element = await page.waitForSelector(selector, {
          timeout: timeoutPerSelector,
          state: "visible",
        });

        if (element) {
          if (action === "click") {
            await element.click();
            this.logger.debug(`Clicked element: ${selector}`);
          } else if (action === "fill" && fillValue !== undefined) {
            await element.fill(fillValue);
            this.logger.debug(`Filled element: ${selector}`);
          }
          return true;
        }
      } catch (error) {
        // Selector failed, try next one
        this.logger.debug(`Selector failed: ${selector}`);
        continue;
      }
    }

    return false;
  }

  /**
   * Wait for redirect back to ServiceNow instance
   * Uses polling loop as primary strategy since page.waitForURL can miss
   * already-completed navigations (race condition with Azure AD redirects)
   */
  private async waitForServiceNowRedirect(
    page: Page,
    timeout: number,
  ): Promise<boolean> {
    this.logger.info("Waiting for ServiceNow redirect");

    const startTime = Date.now();
    const pollInterval = 500; // Check every 500ms

    // Polling loop - more reliable than waitForURL for catching
    // redirects that may have already completed
    while (Date.now() - startTime < timeout) {
      try {
        const currentUrl = page.url();
        if (this.isServiceNowUrl(currentUrl)) {
          this.logger.info(`On ServiceNow: ${currentUrl}`);
          return true;
        }
      } catch {
        // Page might be navigating, ignore errors
      }
      await page.waitForTimeout(pollInterval);
    }

    this.logger.error(
      `Timeout waiting for ServiceNow redirect. Current URL: ${page.url()}`,
    );
    return false;
  }

  /**
   * Check if a URL is a ServiceNow instance URL (and not a login page)
   */
  private isServiceNowUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);

      // Check if we're past login pages
      const isLoginPage =
        url.includes("/login") ||
        url.includes("/saml") ||
        url.includes("/sso") ||
        url.includes("idp") ||
        url.includes("okta") ||
        url.includes("auth0") ||
        url.includes("login.microsoftonline");

      if (isLoginPage) {
        return false; // Still on a login page, not ServiceNow yet
      }

      // If we have a specific instanceUrl, check if it matches
      if (this.instanceUrl) {
        const instanceHostname = new URL(this.instanceUrl).hostname;
        const onCorrectInstance = urlObj.hostname === instanceHostname;

        // Check for ServiceNow-specific URL patterns (comprehensive list)
        const hasServiceNowPath =
          url.includes("/nav") || // Navigator UI (includes navpage.do)
          url.includes("/navpage") || // navpage.do explicitly
          url.includes("/now/") || // Next Experience (Agent Workspace, etc.)
          url.includes("/$") || // Dollar sign paths
          url.includes("/welcome") || // Welcome page
          url.includes("/home") || // Homepage
          url.includes("/sp") || // Service Portal
          url.includes("/csm") || // Customer Service Management
          url.includes("/esc") || // Employee Service Center
          url.includes("/hrsd") || // HR Service Delivery
          url.includes("/itsm") || // IT Service Management
          url.includes("/incident") || // Incident management
          url.includes("/kb_") || // Knowledge Base
          url.includes("/ui/") || // UI pages
          urlObj.pathname === "/" || // Root path (authenticated homepage)
          urlObj.pathname === ""; // Empty path

        return onCorrectInstance && hasServiceNowPath;
      }

      // Fallback: any service-now.com domain with ServiceNow patterns
      const isServiceNowDomain = urlObj.hostname.includes("service-now.com");
      const hasServiceNowPath =
        url.includes("/nav") ||
        url.includes("/navpage") ||
        url.includes("/now/") ||
        url.includes("/$") ||
        url.includes("/welcome") ||
        url.includes("/home") ||
        url.includes("/sp") ||
        url.includes("/csm") ||
        url.includes("/esc") ||
        url.includes("/hrsd") ||
        url.includes("/itsm") ||
        url.includes("/incident") ||
        url.includes("/kb_") ||
        url.includes("/ui/") ||
        urlObj.pathname === "/" ||
        urlObj.pathname === "";

      return isServiceNowDomain && hasServiceNowPath;
    } catch {
      return false;
    }
  }
}
