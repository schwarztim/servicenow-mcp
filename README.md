# ServiceNow MCP Server

[![npm version](https://img.shields.io/npm/v/servicenow-mcp.svg)](https://www.npmjs.com/package/servicenow-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-green.svg)](https://modelcontextprotocol.io)

A comprehensive Model Context Protocol (MCP) server for ServiceNow ITSM with **browser-based SSO authentication** support.

> **Perfect for enterprise environments** - No API keys required. Works with Okta, Azure AD, and any SSO provider.

## Features

- **Browser Authentication**: Log in via your enterprise SSO (Okta, Azure AD, etc.) - no API keys needed
- **70+ Tools**: Incidents, Changes, Problems, Catalog, CMDB, Knowledge Base, Users, Approvals, and more
- **GraphQL & REST Support**: Works with both ServiceNow APIs
- **Session Management**: Automatic cookie handling and refresh

## Installation

### NPM (Coming Soon)

```bash
npm install -g servicenow-mcp
```

### From Source

```bash
git clone https://github.com/yourusername/servicenow-mcp.git
cd servicenow-mcp
npm install
npm run build
```

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

### Service Catalog

- `catalog_items` - Browse catalog items
- `catalog_item_get` - Get item details
- `catalog_order` - Order catalog item
- `catalog_requests` - List requests

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

Add to `~/.claude/user-mcps.json`:

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

- **Issues**: [GitHub Issues](https://github.com/yourusername/servicenow-mcp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/servicenow-mcp/discussions)

## Acknowledgments

- Built with [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk)
- Browser automation powered by [Playwright](https://playwright.dev/)

## License

MIT © Timothy Schwarz - see [LICENSE](LICENSE) for details
