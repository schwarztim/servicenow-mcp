# ServiceNow MCP Authentication Redesign

**Date:** 2026-01-27
**Author:** Claude (with Timothy Schwarz)
**Status:** Approved - Ready for Implementation

## Executive Summary

Replace unreliable manual browser authentication with automated headless browser authentication for Azure AD SSO. Enable enterprise-wide deployment with secure credential management, comprehensive health checks, and self-healing error recovery.

## Problem Statement

**Current Issues:**

- Manual browser window opens for SSO login (interrupts workflow)
- "Works some of the time" - unreliable authentication
- Not suitable for coworker deployment (requires manual intervention)
- No health checking or diagnostics
- Credentials not securely stored

**User Requirements:**

- Fully automated authentication in background
- Use existing credentials (email/password + TOTP MFA)
- Enterprise-ready for engineering team deployment
- Self-healing with comprehensive error recovery
- Clear diagnostics when issues occur

## Solution Overview

### Approach: Headless Browser Automation

**Why headless browser over pure HTTP:**

- Azure AD has anti-automation protections (CAPTCHA, fingerprinting)
- Handles JavaScript-heavy login flows automatically
- More maintainable (selectors vs. HTTP endpoint reverse-engineering)
- Adapts to UI changes better than HTTP flows
- "Headless" means invisible to user (runs in background)

**Authentication Flow:**

```
1. Launch Playwright (headless: true)
2. Navigate to ServiceNow → Azure AD redirect
3. Detect and fill email field
4. Detect and fill password field
5. Detect MFA prompt → call ~/.claude/scripts/totp-gen.sh
6. Fill TOTP code and submit
7. Handle "Stay signed in?" → Yes
8. Wait for ServiceNow redirect
9. Capture cookies (same as current implementation)
10. Store cookies in ~/.servicenow-mcp/cookies.json
```

## Architecture

### File Structure

```
servicenow-mcp/
├── src/
│   ├── auth-browser.ts          # Enhanced with auto-login
│   ├── azure-ad-automator.ts    # NEW: Azure AD form automation
│   ├── auth-config.ts           # NEW: Configuration management
│   ├── credential-store.ts      # NEW: Keychain integration
│   ├── health-check.ts          # NEW: Health check system
│   ├── logger.ts                # NEW: Structured logging
│   ├── browser-auth.ts          # KEEP: BrowserAuthManager (unchanged)
│   ├── index.ts                 # UPDATE: Support credential-based auth
│   └── cli/
│       ├── setup.ts             # NEW: Interactive setup wizard
│       ├── health-check.ts      # NEW: Health check CLI
│       └── reset.ts             # NEW: Reset credentials
├── docs/
│   └── plans/
│       └── 2026-01-27-servicenow-auth-redesign.md  # This document
└── ~/.servicenow-mcp/           # User data (outside repo)
    ├── config.json              # User configuration
    ├── cookies.json             # Session cookies (existing)
    └── logs/
        └── auth-YYYY-MM-DD.log  # Detailed auth logs
```

### Configuration

**Environment Variables (for manual override):**

```bash
SERVICENOW_INSTANCE_URL=https://instance.service-now.com
SERVICENOW_EMAIL=user@example.com
SERVICENOW_PASSWORD=<stored in keychain, not env>
SERVICENOW_MFA_SCRIPT=~/.claude/scripts/totp-gen.sh
SERVICENOW_HEADLESS=true
```

**Config File (~/.servicenow-mcp/config.json):**

```json
{
  "instanceUrl": "https://instance.service-now.com",
  "email": "user@example.com",
  "mfaScript": "~/.claude/scripts/totp-gen.sh",
  "headless": true,
  "timeout": 90000,
  "retryAttempts": 3,
  "logLevel": "INFO"
}
```

**Secure Credential Storage:**

- Use `keytar` library (Electron's credential manager)
- Password stored in system keychain:
  - macOS: Keychain Access
  - Windows: Credential Manager
  - Linux: Secret Service API (gnome-keyring)
- Never store password in plain text files

## Resilience Features

### 1. Multi-Selector Strategy

Azure AD UI can vary by tenant and change over time. Support multiple selector patterns:

```typescript
const SELECTORS = {
  email: [
    'input[name="loginfmt"]', // Standard Azure AD
    'input[type="email"]', // Generic fallback
    'input[name="username"]', // Alternative
  ],
  password: [
    'input[name="passwd"]', // Standard Azure AD
    'input[type="password"]', // Generic fallback
  ],
  mfa: [
    'input[name="otc"]', // One-time code
    'input[id="idTxtBx_SAOTCC_OTC"]', // Azure MFA specific
    'input[placeholder*="code"]', // Generic code input
  ],
  submitButton: [
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Next")',
    'button:has-text("Sign in")',
    'button:has-text("Verify")',
  ],
};
```

**Detection Logic:**

- Try each selector in sequence with 2s timeout
- Wait for element to be visible AND enabled
- Wait for animations/transitions to complete
- Log which selector succeeded for diagnostics

### 2. Retry Strategy

**Per-step retries:**

- Each form detection: 3 attempts with 2s, 5s, 10s delays
- Network errors: 3 attempts with exponential backoff
- Overall flow timeout: 90 seconds (configurable)

**Full flow retries:**

- If any step fails after retries, retry entire flow
- Maximum 3 full flow attempts
- Increasing delays between attempts: 5s, 15s, 30s

**Fallback:**

- After all retries exhausted, fall back to manual browser mode
- Clear error message explaining what failed
- Option to retry or open manual browser

### 3. Azure AD Flow Variants

**Pattern 1: Email-first (most common)**

```
Email → Next → Password → Sign in → MFA → Verify → Stay signed in? → ServiceNow
```

**Pattern 2: Combined email+password**

```
Email + Password → Sign in → MFA → Verify → ServiceNow
```

**Pattern 3: Existing session**

```
Email → Auto-redirect (already authenticated) → ServiceNow
```

**Detection:**

- Use short timeouts (5s) to detect if step is skipped
- Don't fail if optional step missing (e.g., "Stay signed in?")
- Detect successful auth by checking URL (service-now.com)

### 4. Network Resilience

- Increased timeouts for corporate networks (90s default)
- Retry on DNS failures, connection resets
- Handle proxy authentication if configured
- Detect VPN disconnects and provide clear error

### 5. MFA Script Validation

**Pre-flight checks:**

```typescript
async function validateMfaScript(scriptPath: string): Promise<void> {
  // 1. Check file exists
  if (!existsSync(scriptPath)) {
    throw new Error(`MFA script not found: ${scriptPath}`);
  }

  // 2. Check executable permissions
  const stats = statSync(scriptPath);
  if (!(stats.mode & 0o111)) {
    throw new Error(`MFA script not executable: ${scriptPath}`);
  }

  // 3. Test execution using secure execFile (NOT exec - prevents injection)
  // Use execFileNoThrow from src/utils/execFileNoThrow.ts
  const result = await execFileNoThrow(scriptPath, [], { timeout: 5000 });

  // 4. Validate output format (6 digits)
  if (!/^\d{6}$/.test(result.stdout.trim())) {
    throw new Error(`MFA script output invalid: ${result.stdout}`);
  }

  console.log(`✅ MFA script validated: ${scriptPath}`);
}
```

**Security Note:** Always use `execFileNoThrow` instead of `child_process.exec()` to prevent command injection vulnerabilities. The existing codebase provides this utility at `src/utils/execFileNoThrow.ts`.

### 6. Session Management

**Extend session lifetime:**

- Click "Stay signed in" when prompted (extends to 90+ days)
- Refresh cookies proactively before 4-hour expiry
- Store browser fingerprint for device trust

**Session monitoring:**

- Check cookie age on every API call
- Auto-refresh if > 3.5 hours old (before 4-hour expiry)
- Background refresh (doesn't block API calls)

## Health Check System

### Command: `npm run test-auth`

**Checks performed:**

1. **Configuration Check**
   - Config file exists and parseable
   - Required fields present (instanceUrl, email, mfaScript)
   - Values are valid format

2. **Credential Check**
   - Password exists in system keychain
   - Can retrieve password successfully

3. **MFA Script Check**
   - File exists at configured path
   - Has executable permissions
   - Produces valid 6-digit TOTP code
   - Completes in < 5 seconds

4. **Network Check**
   - ServiceNow instance URL is reachable
   - Responds to HTTP request
   - Redirects to Azure AD (validates SSO is configured)

5. **Cookie Check**
   - Existing cookies present (if any)
   - Not expired (< 4 hours old)
   - Contains required session cookies

**Output Format:**

```
🔍 ServiceNow MCP Health Check
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Configuration: Valid
   • Instance: https://instance.service-now.com
   • Email: user@example.com

✅ Credentials: Found in system keychain
   • User: user@example.com
   • Password: ******** (8 characters)

✅ MFA Script: Working
   • Path: /home/user/.claude/scripts/totp-gen.sh
   • Executable: Yes
   • Test output: 123456 (valid 6-digit code)
   • Response time: 0.3s

✅ Network: ServiceNow reachable
   • URL: https://instance.service-now.com
   • Response time: 245ms
   • Redirects to Azure AD: Yes

⚠️  Cookies: Expired (last updated 6 hours ago)
   • Recommendation: Run npm run auth to refresh

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Overall Status: HEALTHY (refresh cookies recommended)

Next steps:
  • Run: npm run auth (to refresh cookies)
  • Estimated time: 15-20 seconds
```

## Setup Wizard

### Command: `npm run setup`

**Interactive flow:**

```typescript
async function setupWizard(): Promise<void> {
  console.log("🚀 ServiceNow MCP Setup Wizard\n");

  // Step 1: Instance URL
  const instanceUrl = await prompt({
    type: "text",
    name: "instanceUrl",
    message: "ServiceNow instance URL:",
    initial: "https://instance.service-now.com",
    validate: (url) => validateUrl(url),
  });

  // Validate URL is reachable
  console.log("⏳ Checking ServiceNow connection...");
  await validateInstanceUrl(instanceUrl);
  console.log("✅ Connection successful\n");

  // Step 2: Email
  const email = await prompt({
    type: "text",
    name: "email",
    message: "Your corporate email:",
    validate: (email) => email.includes("@example.com"),
  });

  // Step 3: Password (hidden input)
  const password = await prompt({
    type: "password",
    name: "password",
    message: "Password:",
  });

  // Store in keychain
  console.log("🔐 Storing credentials securely...");
  await credentialStore.setPassword(email, password);
  console.log("✅ Credentials stored in system keychain\n");

  // Step 4: MFA Script
  const mfaScript = await prompt({
    type: "text",
    name: "mfaScript",
    message: "MFA script path:",
    initial: "~/.claude/scripts/totp-gen.sh",
  });

  // Validate MFA script
  console.log("🧪 Testing MFA script...");
  const code = await testMfaScript(mfaScript);
  console.log(`✅ Generated test code: ${code}\n`);

  // Step 5: Save configuration
  const config: AuthConfig = {
    instanceUrl,
    email,
    mfaScript,
    headless: true,
    timeout: 90000,
    retryAttempts: 3,
    logLevel: "INFO",
  };
  configManager.save(config);
  console.log("✅ Configuration saved\n");

  // Step 6: Test full authentication
  console.log("🔐 Testing full authentication flow...");
  console.log("(This will perform a headless login - takes 15-20 seconds)\n");

  const spinner = ora("Authenticating...").start();

  const authResult = await authenticateViaBrowser(instanceUrl, {
    email,
    password,
    mfaScript,
    headless: true,
  });

  if (authResult.success) {
    spinner.succeed("Authentication successful!");
    console.log("\n✅ Setup complete! ServiceNow MCP is ready to use.\n");
    console.log("Test anytime with: npm run test-auth");
  } else {
    spinner.fail("Authentication failed");
    console.log(`\n❌ Error: ${authResult.error}\n`);
    console.log("Please check your credentials and try again.");
    console.log("Run: npm run setup (to retry)");
  }
}
```

## Logging System

### Log Levels

- **DEBUG**: Detailed step-by-step flow (selector detection, page transitions)
- **INFO**: Key events (starting auth, MFA code generated, success/failure)
- **WARN**: Recoverable issues (selector fallback, retry attempts)
- **ERROR**: Unrecoverable failures (wrong credentials, network timeout)

### Log Format

```
2026-01-27 15:23:01 [INFO] Starting authentication flow
2026-01-27 15:23:02 [DEBUG] Navigating to https://instance.service-now.com
2026-01-27 15:23:05 [DEBUG] Redirected to Azure AD: login.microsoftonline.com/example.com
2026-01-27 15:23:06 [DEBUG] Detected email input (selector: input[name="loginfmt"])
2026-01-27 15:23:06 [INFO] Filling email: t***@example.com
2026-01-27 15:23:07 [DEBUG] Clicked Next button
2026-01-27 15:23:09 [DEBUG] Password page loaded
2026-01-27 15:23:09 [INFO] Filling password: ***
2026-01-27 15:23:10 [DEBUG] Clicked Sign In
2026-01-27 15:23:12 [DEBUG] MFA page detected
2026-01-27 15:23:12 [INFO] Calling MFA script: ~/.claude/scripts/totp-gen.sh
2026-01-27 15:23:13 [DEBUG] MFA code received: 123***
2026-01-27 15:23:13 [INFO] Submitting MFA code
2026-01-27 15:23:15 [DEBUG] "Stay signed in?" prompt detected - selecting Yes
2026-01-27 15:23:16 [DEBUG] Redirecting to ServiceNow...
2026-01-27 15:23:20 [INFO] ✓ Authentication successful
2026-01-27 15:23:20 [INFO] Captured 12 cookies
```

### Sensitive Data Sanitization

**Never log in plain text:**

- Passwords
- Full email addresses (mask: t\*\*\*@example.com)
- Full TOTP codes (mask: 123\*\*\*)
- Full cookies

**Do log:**

- Which selector succeeded
- Page URLs
- Timing information
- Error messages (sanitized)

### Log Rotation

- Daily log files: `~/.servicenow-mcp/logs/auth-YYYY-MM-DD.log`
- Keep last 7 days
- Automatically clean up old logs
- Max file size: 10MB (rotate if exceeded)

## Error Handling

### Error Categories

**1. Configuration Errors (User Fixable)**

```
❌ MFA Script: Not found
   Path: ~/.claude/scripts/totp-gen.sh

   Fix this:
   1. Check the path exists
   2. Run: npm run setup (to reconfigure)
```

**2. Credential Errors (User Fixable)**

```
❌ Authentication: Invalid credentials
   Email: user@example.com

   Fix this:
   1. Verify your password is correct
   2. Run: npm run setup (to update credentials)
```

**3. Network Errors (Environmental)**

```
❌ Network: Cannot reach ServiceNow
   URL: https://instance.service-now.com
   Error: Connection timeout after 90s

   Possible causes:
   • VPN not connected
   • Internet connection down
   • ServiceNow maintenance window

   Retry in a few minutes or check VPN connection
```

**4. Automation Errors (Selector Changes)**

```
❌ Azure AD: Could not detect email input field
   Page title: "Sign in - Microsoft"
   Available inputs: [debug info]

   This likely means Azure AD's UI changed.
   Falling back to manual browser mode...

   Please report this issue for selector updates.
```

### Error Recovery

**Automatic Recovery:**

- Retry with exponential backoff
- Try alternative selectors
- Fall back to manual browser mode

**User Actions Required:**

- Wrong credentials → Update via `npm run setup`
- MFA script broken → Fix script, verify with `npm run test-auth`
- Network issues → Check VPN, wait and retry

## Implementation Plan

### Phase 1: Core Infrastructure (Day 1-2)

- [ ] Set up new file structure
- [ ] Implement `CredentialStore` (keytar integration)
- [ ] Implement `ConfigManager`
- [ ] Implement `Logger` with sanitization
- [ ] Add new dependencies to package.json

### Phase 2: Azure AD Automation (Day 3-4)

- [ ] Implement `AzureADAutomator` class
- [ ] Multi-selector detection logic
- [ ] Email/password/MFA filling
- [ ] "Stay signed in" handling
- [ ] ServiceNow redirect detection

### Phase 3: Setup & Health Check (Day 5)

- [ ] Setup wizard CLI
- [ ] Health check implementation
- [ ] Reset credentials command

### Phase 4: Integration (Day 6)

- [ ] Update `auth-browser.ts` with auto-login
- [ ] Update `index.ts` MCP tools
- [ ] Add retry logic and error handling
- [ ] Integrate logging throughout

### Phase 5: Testing (Day 7)

- [ ] Unit tests for AzureADAutomator
- [ ] Integration test with real credentials
- [ ] Test all error scenarios
- [ ] Test health check coverage

### Phase 6: Documentation & Rollout (Day 8)

- [ ] User documentation (README)
- [ ] Troubleshooting guide
- [ ] Internal Corporate deployment guide
- [ ] Pilot with 2-3 coworkers

## Testing Strategy

### Unit Tests

```typescript
// tests/azure-ad-automator.test.ts
describe("AzureADAutomator", () => {
  test("detects email field with primary selector");
  test("falls back to secondary selector");
  test("handles MFA script timeout gracefully");
  test("retries on network errors");
  test("sanitizes sensitive data in logs");
});
```

### Integration Tests

```typescript
// tests/integration/full-auth-flow.test.ts
describe("Full Authentication Flow", () => {
  test("completes login with valid credentials");
  test("fails gracefully with wrong password");
  test("retries after transient network error");
  test("falls back to manual mode after selector failure");
});
```

### Manual Testing Checklist

**Setup Flow:**

- [ ] Fresh install: `npm install`
- [ ] Run setup wizard: `npm run setup`
- [ ] Verify config file created
- [ ] Verify password stored in keychain
- [ ] Verify MFA script validated
- [ ] Verify test authentication succeeds

**Health Check:**

- [ ] Run: `npm run test-auth`
- [ ] All checks pass with valid config
- [ ] Clear error messages with invalid config
- [ ] Recommendations are actionable

**Authentication:**

- [ ] Automated login succeeds (headless)
- [ ] Cookies saved correctly
- [ ] ServiceNow API calls work with cookies
- [ ] Re-auth when cookies expire
- [ ] Background re-auth doesn't block API calls

**Error Scenarios:**

- [ ] Wrong password → clear error, doesn't retry indefinitely
- [ ] Wrong MFA code → retries or fails gracefully
- [ ] Network timeout → retries with backoff
- [ ] Azure AD selector changed → fallback to manual
- [ ] MFA script not found → clear error message
- [ ] VPN disconnected → clear network error

**Multi-User:**

- [ ] Different user can run setup independently
- [ ] No conflicts between user credentials
- [ ] Each user's logs separate

## Rollout Plan

### Phase 1: Developer Testing (Week 1)

- Timothy tests with personal credentials
- Verify reliability over 1 week of daily use
- Document any corporate Azure AD quirks
- Fix bugs discovered during testing

### Phase 2: Pilot Group (Week 2)

- Share with 2-3 trusted coworkers
- Provide installation instructions
- Collect feedback on setup process
- Monitor health check usage
- Fix environment-specific issues

### Phase 3: Team Rollout (Week 3+)

- Share with entire engineering team
- Provide documentation:
  - Installation guide
  - Troubleshooting guide
  - FAQ
- Monitor common issues via logs
- Iterate on error messages based on feedback

## Documentation for Coworkers

### Quick Start Guide

````markdown
# ServiceNow MCP - Quick Start

## First Time Setup (5 minutes)

1. Install:
   ```bash
   cd ~/Scripts/mcp-servers/servicenow-mcp
   git pull  # Get latest updates
   npm install
   npm run setup  # Follow wizard
   ```
````

2. Follow the setup wizard:
   - Enter ServiceNow URL: https://instance.service-now.com
   - Enter your corporate email
   - Enter your password (stored securely)
   - Confirm MFA script path

3. Test it works:
   ```bash
   npm run test-auth
   ```

## Daily Usage

The MCP handles authentication automatically. No action needed!

If you get auth errors:

```bash
npm run auth  # Refreshes your session
```

## Troubleshooting

**"MFA script failed"**

- Run: `MFA setup` to configure your TOTP secret

**"Network timeout"**

- Check VPN is connected
- Verify you can access https://instance.service-now.com in browser

**"Cookies expired"**

- Run: `npm run auth` to refresh

**Still stuck?**

- Run: `npm run test-auth` and share output
- Check logs: `~/.servicenow-mcp/logs/`
- Contact Timothy Schwarz

````

## Success Metrics

**Reliability:**
- [ ] 95%+ success rate on first authentication attempt
- [ ] < 20 seconds average authentication time
- [ ] Zero manual interventions after setup

**Usability:**
- [ ] Setup completes in < 5 minutes for new users
- [ ] Health check catches 90%+ of issues before they cause failures
- [ ] Error messages are actionable (users know how to fix)

**Adoption:**
- [ ] 10+ engineering team members successfully deployed
- [ ] < 2 support requests per user (after initial setup)
- [ ] Positive feedback on automation vs. manual browser

## Dependencies

### New npm Packages

```json
{
  "keytar": "^7.9.0",          // Secure credential storage
  "chalk": "^5.3.0",            // Colored terminal output
  "ora": "^8.0.1",              // Spinners for long operations
  "prompts": "^2.4.2",          // Interactive CLI prompts
  "winston": "^3.11.0"          // Structured logging
}
````

### System Requirements

- **macOS**: Keychain Access available
- **Windows**: Credential Manager available
- **Linux**: gnome-keyring or compatible Secret Service API

## Future Enhancements

**Post-MVP considerations:**

1. **Refresh token support**: If Azure AD supports OAuth refresh tokens, implement automatic token refresh without full re-auth

2. **Multi-instance support**: Allow configuration for multiple ServiceNow instances (dev, staging, prod)

3. **Team credential sharing**: Investigate service account setup for shared CI/CD authentication

4. **Performance optimization**: Cache successful selector patterns to speed up subsequent logins

5. **Metrics dashboard**: Track authentication success rates, common failure modes, average auth times

## Risk Mitigation

**Risk: Azure AD changes UI and breaks automation**

- Mitigation: Multi-selector strategy, fallback to manual mode
- Detection: Health check monitors in pilot phase
- Recovery: Quick selector updates, communicate to users

**Risk: MFA script stops working**

- Mitigation: Validate script in health check
- Detection: Clear error messages
- Recovery: User runs `MFA setup` again

**Risk: ServiceNow session expires during API calls**

- Mitigation: Proactive cookie refresh at 3.5 hours
- Detection: Monitor API response codes (401/403)
- Recovery: Automatic background re-auth

**Risk: Coworkers have different Azure AD configurations**

- Mitigation: Support multiple flow patterns
- Detection: Logging shows which pattern each user hits
- Recovery: Add new patterns as discovered

## Approval

**Design Approved By:** Timothy Schwarz
**Date:** 2026-01-27
**Status:** ✅ Ready for Implementation

**Next Steps:**

1. Set up git worktree for isolated development
2. Implement Phase 1 (Core Infrastructure)
3. Test with Timothy's credentials
4. Iterate based on testing feedback
