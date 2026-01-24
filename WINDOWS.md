# Windows Installation Guide

Complete guide for installing and using ServiceNow MCP on Windows.

## Prerequisites

1. **Node.js 18+**: Download from https://nodejs.org/
   - Verify: `node --version` (should be 18.0.0 or higher)
   - Verify: `npm --version`

2. **Git for Windows** (optional, for cloning): https://git-scm.com/download/win

## Installation

### Option 1: Install from npm (Recommended)

```powershell
npm install -g servicenow-mcp
```

### Option 2: Install from Source

#### Using PowerShell (Recommended)

```powershell
# Clone the repository
git clone https://github.com/schwarztim/servicenow-mcp.git
cd servicenow-mcp

# Run installation script
.\scripts\install.ps1
```

#### Using Command Prompt

```cmd
REM Clone the repository
git clone https://github.com/schwarztim/servicenow-mcp.git
cd servicenow-mcp

REM Run installation script
scripts\install.cmd
```

#### Manual Installation

```powershell
# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

### Claude Desktop Configuration

Edit your Claude configuration file:

```
%USERPROFILE%\.claude\user-mcps.json
```

Add the ServiceNow MCP server:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "node",
      "args": [
        "C:\\Users\\YourUsername\\path\\to\\servicenow-mcp\\dist\\index.js"
      ],
      "env": {
        "SERVICENOW_INSTANCE_URL": "https://yourinstance.service-now.com"
      }
    }
  }
}
```

**Important**: Use double backslashes (`\\`) in Windows paths!

### Environment Variables (Optional)

Create a `.env` file in the project directory or set system environment variables:

**Using PowerShell:**

```powershell
$env:SERVICENOW_INSTANCE_URL = "https://yourinstance.service-now.com"
$env:SERVICENOW_USERNAME = "your-username"
$env:SERVICENOW_PASSWORD = "your-password"
```

**Using Command Prompt:**

```cmd
set SERVICENOW_INSTANCE_URL=https://yourinstance.service-now.com
set SERVICENOW_USERNAME=your-username
set SERVICENOW_PASSWORD=your-password
```

**Using System Environment Variables:**

1. Press `Win + X` and select "System"
2. Click "Advanced system settings"
3. Click "Environment Variables"
4. Add the variables under "User variables"

## Authentication

### Browser SSO Authentication (Recommended)

The browser authentication works seamlessly on Windows with Chrome/Edge:

```powershell
npm run auth https://yourinstance.service-now.com
```

This will:

1. Launch a Chromium browser window
2. Navigate to your ServiceNow instance
3. Allow you to log in with SSO (Okta, Azure AD, etc.)
4. Automatically capture and save session cookies

Cookies are saved to: `%USERPROFILE%\.servicenow-mcp\cookies.json`

### Using Claude Desktop

Once configured, use the `auth_browser` tool from Claude:

```
> Use auth_browser to authenticate to ServiceNow
```

## Troubleshooting

### "playwright: command not found" or Browser Install Fails

Manually install Playwright browsers:

```powershell
npx playwright install chromium
```

### Path Issues in user-mcps.json

**Wrong:**

```json
"args": ["C:\Users\Tim\servicenow-mcp\dist\index.js"]  ❌ Single backslash
```

**Correct:**

```json
"args": ["C:\\Users\\Tim\\servicenow-mcp\\dist\\index.js"]  ✅ Double backslash
```

Or use forward slashes:

```json
"args": ["C:/Users/Tim/servicenow-mcp/dist/index.js"]  ✅ Forward slash
```

### Permission Denied Errors

Run PowerShell as Administrator:

1. Press `Win + X`
2. Select "Windows PowerShell (Admin)" or "Terminal (Admin)"

### Playwright Browser Launch Fails

Check Windows Defender or antivirus settings:

1. Open Windows Security
2. Go to "Virus & threat protection"
3. Click "Manage settings"
4. Add Playwright/Chromium to exclusions if needed

### npm Scripts Not Working

Ensure npm is in your PATH:

```powershell
# Check npm path
npm config get prefix

# Add to PATH if needed (restart terminal after)
$env:PATH += ";C:\Users\YourUsername\AppData\Roaming\npm"
```

### Cookie File Not Found

The cookie directory should be created automatically at:

```
%USERPROFILE%\.servicenow-mcp\cookies.json
```

If it's not created, manually create it:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.servicenow-mcp"
```

## Windows-Specific Notes

### File Paths

- Always use double backslashes (`\\`) in JSON config files
- OR use forward slashes (`/`) which work on Windows too
- Node.js `path.join()` handles this automatically in code

### User Directory

- Windows: `C:\Users\YourUsername\.servicenow-mcp`
- The `~` shorthand doesn't work in Windows JSON configs
- Use `%USERPROFILE%` in documentation, but full paths in JSON

### Scripts

- `.sh` scripts won't work on Windows
- Use `.cmd` (Command Prompt) or `.ps1` (PowerShell) scripts
- npm scripts work cross-platform

### Browsers

- Playwright installs Chromium automatically
- Works with Windows Defender and modern antivirus
- Uses native Windows browser rendering

## PowerShell Execution Policy

If you get "script execution disabled" errors:

```powershell
# Check current policy
Get-ExecutionPolicy

# Allow scripts for current user (recommended)
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# Or run with bypass
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

## Firewall Configuration

If ServiceNow blocks requests:

1. Open Windows Defender Firewall
2. Click "Allow an app through firewall"
3. Add Node.js if not present
4. Ensure both Private and Public networks are checked

## Testing Installation

```powershell
# Test Node.js version
node --version

# Test npm
npm --version

# Test build
npm run build

# Test authentication
npm run auth https://yourinstance.service-now.com

# Test MCP server
node dist\index.js
```

## Getting Help

- **Issues**: https://github.com/schwarztim/servicenow-mcp/issues
- **Discussions**: https://github.com/schwarztim/servicenow-mcp/discussions
- Tag issues with `windows` label for Windows-specific problems

## Platform-Specific Features

Windows-specific user agent is automatically detected and used:

```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...
```

This ensures SSO providers recognize Windows browsers correctly.
