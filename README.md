# ServiceNow MCP Server

[![npm version](https://img.shields.io/npm/v/servicenow-mcp.svg)](https://www.npmjs.com/package/servicenow-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-green.svg)](https://modelcontextprotocol.io)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)](https://github.com/schwarztim/servicenow-mcp)

A comprehensive Model Context Protocol (MCP) server for ServiceNow ITSM with **browser-based SSO authentication** support.

> **Perfect for enterprise environments** - No API keys required. Works with Okta, Azure AD, and any SSO provider.

## Features

- **Browser Authentication**: Log in via your enterprise SSO (Okta, Azure AD, etc.) - no API keys needed
- **80+ Tools**: Incidents, Changes, Problems, Catalog, CMDB, Knowledge Base, Users, Approvals, and more
- **Complete Request Type Coverage**: Standard catalog items, Record Producers, Order Guides, and Content Items
- **IT Service Portal Integration**: Direct submission from ITSP URLs
- **GraphQL & REST Support**: Works with both ServiceNow APIs
- **Session Management**: Automatic cookie handling and refresh

## Installation

### NPM

```bash
npm install servicenow-mcp
```

Or install globally:

```bash
npm install -g servicenow-mcp
```

### From Source

**Linux/macOS:**

```bash
git clone https://github.com/schwarztim/servicenow-mcp.git
cd servicenow-mcp
npm install
npm run build
```

**Windows:**

```powershell
git clone https://github.com/schwarztim/servicenow-mcp.git
cd servicenow-mcp
.\scripts\install.ps1
```

> 📝 **Windows Users**: See [WINDOWS.md](WINDOWS.md) for detailed Windows installation guide, including path configuration, PowerShell setup, and troubleshooting.

## Authentication Methods

### 1. Browser SSO (Recommended for Enterprise)

Use the `auth_browser` tool from Claude:

```
> Use auth_browser to log into ServiceNow

A browser will open. Log in with your SSO credentials.
Cookies are automatically captured and saved.
```

Or from command line:

```bash
npm run auth https://yourinstance.service-now.com
```

### 2. Basic Auth (Username/Password)

Set environment variables:

```bash
export SERVICENOW_INSTANCE_URL="https://yourinstance.service-now.com"
export SERVICENOW_USERNAME="your-username"
export SERVICENOW_PASSWORD="your-password"
```

### 3. Session Token Auth

For GraphQL API access:

```bash
export SERVICENOW_INSTANCE_URL="https://yourinstance.service-now.com"
export SERVICENOW_SESSION_TOKEN="your-session-cookie"
export SERVICENOW_USER_TOKEN="your-g_ck-token"
```

## Usage with Claude

After browser authentication:

```
> List open P1 incidents
> Show me change CHG0012345
> Create an incident for "Email server down"
> Search CMDB for servers in the Atlanta datacenter
```

### IT Service Portal (ITSP) Workflows

Submit requests directly from portal URLs (auto-detects Standard/Producer/Guide):

```
> Get details for this catalog item: https://instance.service-now.com/itsp?id=sc_cat_item&sys_id=xxx
> Submit request for this ITSP item: https://instance.service-now.com/itsp?id=sc_cat_item&sys_id=xxx
> Show my recent service requests with details
```

### All Request Types Supported

**Standard Items** (laptops, software, access requests):

```
> Order item a5a360ffdb10fb80ec8dfb61d9619ea with variables {location: "Building A"}
```

**Record Producers** (create incidents, problems):

```
> Submit record producer for incident with description "Network outage"
```

**Order Guides** (multi-item bundles):

```
> Submit order guide with items [laptop, monitor, keyboard]
```

## Available Tools

### Incidents

- `incidents_list` - List incidents with filtering
- `incidents_get` - Get incident details
- `incidents_create` - Create new incident
- `incidents_update` - Update incident
- `incidents_resolve` - Resolve incident

### Changes

- `changes_list` - List change requests
- `changes_get` - Get change details
- `changes_create` - Create change request
- `changes_tasks` - Get change tasks

### Service Catalog (All Request Types)

**Standard Catalog Items** (cart-based ordering):

- `catalog_items` - Browse catalog items
- `catalog_item_get` - Get item details
- `catalog_order` - Order catalog item
- `catalog_order_now` - Single-step ordering
- `catalog_add_to_cart` / `catalog_submit_cart` - Multi-item ordering

**Record Producers** (direct record creation):

- `record_producer_submit` - Submit record producer (creates incidents, problems, etc.)
- `record_producer_get_details` - Get record producer details and variables

**Order Guides** (multi-item bundles):

- `order_guide_submit` - Submit order guide with multiple items
- `order_guide_get_details` - Get order guide details and available items

**Detection & Helpers**:

- `catalog_detect_item_type` - Auto-detect item type (Standard/Producer/Guide/Content)
- `catalog_requests` - List requests

### IT Service Portal (ITSP)

- `itsp_parse_url` - Extract catalog item info from portal URLs
- `itsp_get_item_details` - Get item details from ITSP URL
- `itsp_submit_request` - Submit request directly from ITSP URL (auto-detects type)
- `requests_get_details` - Get detailed request information
- `requests_get_my_recent` - Get recent requests with full details

### CMDB

- `cmdb_list` - Query configuration items
- `cmdb_get` - Get CI details
- `cmdb_relationships` - View CI relationships
- `cmdb_create` - Create CI

### Knowledge Base

- `kb_search` - Search knowledge articles
- `kb_article_get` - Get article content

### Users & Groups

- `users_search` - Search users
- `user_get` - Get user details
- `groups_list` - List groups
- `group_members` - Get group members

### And many more...

- Approvals, SLAs, Workflows, Email, Events, Audit, Update Sets, Security ACLs, Discovery, etc.

## Configuration

Add to your Claude configuration file:

**Linux/macOS:** `~/.claude/user-mcps.json`
**Windows:** `%USERPROFILE%\.claude\user-mcps.json`

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "node",
      "args": [
        "/Users/yourname/Scripts/mcp-servers/servicenow-mcp/dist/index.js"
      ],
      "env": {
        "SERVICENOW_INSTANCE_URL": "https://yourinstance.service-now.com"
      }
    }
  }
}
```

**Windows users**: Use double backslashes in paths:

```json
"args": ["C:\\Users\\YourName\\servicenow-mcp\\dist\\index.js"]
```

Or use forward slashes (also works on Windows):

```json
"args": ["C:/Users/YourName/servicenow-mcp/dist/index.js"]
```

## Troubleshooting

### "No authentication configured"

Run `auth_browser` tool or set environment variables.

### "Cookies expired"

Browser cookies are valid for ~8 hours. Re-run `auth_browser` to refresh.

### "Access denied"

Ensure your ServiceNow user has appropriate roles (itil, admin, etc.).

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## Support

- **Issues**: [GitHub Issues](https://github.com/schwarztim/servicenow-mcp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/schwarztim/servicenow-mcp/discussions)

## Acknowledgments

- Built with [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk)
- Browser automation powered by [Playwright](https://playwright.dev/) with Firefox

## Hermes Integration (Optional)

For containerized deployment, this MCP supports [Hermes](https://github.com/schwarztim/hermes) for centralized authentication:

1. Install and start the Hermes broker on your host
2. Set `HERMES_URL` and `HERMES_CLIENT_TOKEN` environment variables
3. When these env vars are present, auth tokens are fetched from Hermes automatically
4. When absent, the MCP handles authentication directly (standalone mode)

## License

MIT © Timothy Schwarz - see [LICENSE](LICENSE) for details
