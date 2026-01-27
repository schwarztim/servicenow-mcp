# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.1] - 2026-01-27

### Changed

**MFA/TOTP is now optional**

- Setup wizard allows skipping MFA script configuration (leave empty to skip)
- If MFA field appears but no script configured, waits for manual entry (browser stays open)
- Automated authentication works without MFA for environments that don't require it

**Improved authentication behavior**

- `auth_browser` tool now respects config's headless setting (defaults to background auth if configured)
- Tool automatically loads credentials from keychain for automated authentication
- Falls back to manual authentication only if automated auth fails or no credentials available

**Silent background re-authentication**

- When cookies expire (>8 hours), MCP attempts headless re-authentication automatically
- Uses stored credentials from keychain (no interactive prompts)
- Only falls back to interactive setup if background re-auth fails
- Eliminates need for manual re-authentication in most cases

### Fixed

- Auto-setup now properly handles async operations
- Background authentication works seamlessly when MCP starts

## [2.2.0] - 2026-01-27

### Added - Automated Authentication & Zero-Config Onboarding

**🎉 Major Feature: Fully Automated Azure AD Authentication**

Employees can now onboard in 2-3 minutes with authentication happening completely in the background.

**What's New:**

1. **Headless Authentication** (Background by Default)
   - Automatic email/password entry
   - Automatic "Stay signed in?" button click
   - Automatic session capture (31 cookies)
   - Zero browser visibility during normal operation

2. **Auto-Setup on First Run**
   - Detects missing/expired configuration automatically
   - Runs setup wizard on first MCP startup
   - No manual configuration needed
   - Employees just add MCP to Claude Desktop → setup runs automatically

3. **Intelligent Fallback**
   - If background auth fails → browser opens automatically
   - User completes login manually once
   - Session captured → works automatically from then on

4. **Self-Healing Authentication**
   - Detects expired cookies (>8 hours old)
   - Automatically re-authenticates in background
   - Falls back to visible browser if needed

5. **Interactive Setup Wizard** (`npm run setup`)
   - User-friendly prompts for credentials
   - Validates ServiceNow instance URL
   - Tests MFA script execution
   - Stores passwords securely in system keychain
   - Tests authentication before saving

6. **Health Check System** (`npm run health-check`)
   - Configuration validation
   - Credential availability check
   - MFA script testing
   - Network connectivity test
   - Cookie age validation
   - Actionable recommendations

**New Files:**

- `src/azure-ad-automator.ts` - Core automation logic (401 lines)
- `src/cli/setup.ts` - Interactive setup wizard (400+ lines)
- `src/cli/health-check.ts` - Health check CLI
- `src/health-check.ts` - Health check logic (448 lines)
- `src/logger.ts` - Winston logging with sensitive data sanitization
- `src/auth-config.ts` - Configuration management
- `src/credential-store.ts` - System keychain integration
- `src/auto-setup.ts` - Auto-setup detection
- `SETUP.md` - Employee onboarding documentation

**Dependencies Added:**

- `keytar@^7.9.0` - System keychain (macOS/Windows/Linux)
- `chalk@^5.3.0` - Terminal colors
- `ora@^8.0.1` - Loading spinners
- `prompts@^2.4.2` - Interactive prompts
- `winston@^3.11.0` - Structured logging

**Security:**

- Passwords stored in OS keychain only (never in files)
- Cookies expire after 8 hours
- Automatic sensitive data sanitization in logs
- All authentication via Azure AD SSO

**Documentation:**

- See `SETUP.md` for employee onboarding guide
- See `IMPLEMENTATION-SUMMARY.md` for technical details

## [2.1.0] - 2026-01-26

### Changed - Firefox Migration

**Browser Authentication**:

- Migrated from Chromium to Firefox for browser-based SSO authentication
- Updated Playwright to use `firefox` instead of `chromium`
- Updated user agent strings to Firefox 122.0
- Updated postinstall script to install Firefox browser

### Why Firefox?

- Better integration with firefox-devtools-mcp ecosystem
- More consistent browser automation experience
- Improved compatibility with enterprise SSO systems
- Firefox DevTools provide better debugging capabilities

### Breaking Changes

None - all existing functionality remains backward compatible. Only the underlying browser engine changed from Chromium to Firefox.

## [2.0.0] - 2026-01-26

### Added - COMPLETE ServiceNow Request Type Coverage

**IT Service Portal (ITSP) Support**:

- `itsp_parse_url` - Parse ITSP URLs to extract catalog item sys_id and metadata
- `itsp_get_item_details` - Get complete catalog item details from ITSP URL
- `itsp_submit_request` - Submit service requests directly from ITSP URLs (auto-detects type)

**Record Producer Support** (NEW):

- `record_producer_submit` - Submit record producers that create incidents, problems, and other records directly
- `record_producer_get_details` - Get record producer details including variables and target table

**Order Guide Support** (NEW):

- `order_guide_submit` - Submit order guides with multiple catalog items in a single request
- `order_guide_get_details` - Get order guide details and available items

**Enhanced Request Tracking**:

- `requests_get_details` - Get comprehensive request information including items, approvals, and activity history
- `requests_get_my_recent` - Get recent service requests with full details

**Item Type Detection**:

- `catalog_detect_item_type` - Automatically detect catalog item type (Standard, Record Producer, Order Guide, or Content)

### Changed

- Enhanced request tracking with detailed status information
- Improved catalog item variable retrieval workflow
- Updated tool count: 70+ → 80+ tools
- ITSP submission now auto-detects item type

### Coverage

✅ **ALL 4 ServiceNow Request Types Now Supported**:

1. Standard Catalog Items (cart-based ordering)
2. Record Producers (direct record creation)
3. Order Guides (multi-item bundles)
4. Content Items (informational only)

### Documentation

- Added comprehensive request type documentation to README
- Added examples for all request types
- Added IT Service Portal section with auto-detection examples
- Updated CHANGELOG with version 2.0.0 details

### Breaking Changes

None - all existing tools remain backward compatible

## [1.3.0] - 2026-01-26

### Added

- **IT Service Portal (ITSP) Support**: New tools for working with ServiceNow IT Service Portal URLs
  - `itsp_parse_url` - Parse ITSP URLs to extract catalog item sys_id and metadata
  - `itsp_get_item_details` - Get complete catalog item details from ITSP URL
  - `itsp_submit_request` - Submit service requests directly from ITSP URLs
  - `requests_get_details` - Get comprehensive request information including items, approvals, and activity history
  - `requests_get_my_recent` - Get recent service requests with full details

### Changed

- Enhanced request tracking with detailed status information
- Improved catalog item variable retrieval workflow

### Fixed

- No bugs fixed in this release (feature enhancement only)

### Documentation

- Added ITSP workflow examples to README
- Added IT Service Portal section to tool documentation

## [1.2.0] - Previous Release

### Features

- 70+ ServiceNow tools for comprehensive ITSM operations
- Browser-based SSO authentication support
- REST Table API and GraphQL API support
- Session management with automatic cookie handling
