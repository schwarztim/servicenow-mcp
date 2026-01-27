# ServiceNow MCP - Employee Onboarding Guide

## First-Time Setup (5 minutes)

The ServiceNow MCP automatically handles authentication in the background. You just need to configure it once.

### Automatic Setup

**The MCP will automatically run setup when you first use it.** Just add it to your Claude Desktop config and it will prompt you to configure it on first use.

### Manual Setup (Alternative)

If you prefer to set up before first use:

```bash
npm run setup
```

You'll be asked for:

1. **ServiceNow URL**: `https://instance.service-now.com`
2. **Your Corporate Email**: `firstname.lastname@example.com`
3. **Your Password**: Your Corporate password
4. **MFA Script**: `MFA` (the alias for your TOTP generator)

**That's it!** The setup wizard will:

- ✅ Test your credentials in the background (headless browser)
- ✅ Capture your authentication session
- ✅ Save everything securely (password in system keychain, cookies encrypted)

If background auth fails, a browser window will open for you to complete login manually.

## How Authentication Works

### On First Run

1. Setup wizard runs automatically (or manually via `npm run setup`)
2. Credentials stored securely in macOS Keychain / Windows Credential Manager
3. Session cookies saved (valid for 8 hours)

### During Normal Operation

1. MCP uses saved cookies (no browser needed!)
2. Authentication happens silently in background
3. If cookies expire (>8 hours), setup runs automatically again

### If Issues Occur

- A browser window opens automatically for manual login
- Complete the login, and the MCP captures your new session
- Everything continues working automatically

## Troubleshooting

### "Background authentication failed"

This is normal! A browser window will open for manual login. Complete the Azure AD flow and the MCP will capture your session.

### "Authentication cookies expired"

Run `npm run setup` again, or just use the MCP - it will automatically re-authenticate.

### "No configuration found"

The MCP will automatically run setup on first use. If you see this repeatedly, check that `~/.servicenow-mcp/config.json` exists.

## For IT/Setup Administrators

### Configuration Files

All configuration is stored in `~/.servicenow-mcp/`:

- `config.json` - Instance URL, email, MFA script path, settings
- `cookies.json` - Session cookies (encrypted)
- Passwords are stored in OS keychain (not in files)

### Network Requirements

- Access to `instance.service-now.com`
- Access to `login.microsoftonline.com` (Azure AD)
- VPN may be required (check with IT)

### Security

- Passwords never stored in files (OS keychain only)
- Cookies encrypted at rest
- Session expires after 8 hours (automatic re-auth)
- All authentication happens via corporate Azure AD SSO

### Adding to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "node",
      "args": ["/path/to/servicenow-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. The setup wizard will run automatically on first use.

## Support

If you encounter issues:

1. Check VPN connection (required for corporate ServiceNow access)
2. Run `npm run health-check` to diagnose problems
3. Re-run setup: `npm run setup`
4. Contact IT if issues persist

---

**Questions?** Contact the Platform Engineering team or check the internal wiki for ServiceNow MCP documentation.
