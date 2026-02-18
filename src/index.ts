#!/usr/bin/env node
/**
 * ServiceNow MCP Server
 *
 * Comprehensive MCP for ServiceNow ITSM operations:
 * - Incidents, Changes, Problems
 * - Service Catalog & Requests
 * - CMDB Configuration Items
 * - Knowledge Base
 * - Users, Groups, Approvals
 *
 * Supports:
 * - Browser-based SSO authentication (recommended for enterprise)
 * - REST Table API (basic auth)
 * - GraphQL API (session-based)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  loadCookies,
  authenticateViaBrowser,
  importCookies,
  refreshSession,
} from "./auth-browser.js";
import { BrowserAuthManager } from "./browser-auth.js";
import { getAuthHeaders, clearCache as clearAuthCache, triggerSSOAuth } from "./auth.js";
import { autoSetup } from "./auto-setup.js";
import { ConfigManager } from "./auth-config.js";
import { CredentialStore } from "./credential-store.js";
import {
  robustAuthenticate,
  handleAuthFailure,
  validateSession as robustValidateSession,
} from "./robust-auth.js";

// Configuration from environment
const INSTANCE_URL = process.env.SERVICENOW_INSTANCE_URL || "";
const TARGET_URL = INSTANCE_URL || "https://instance.service-now.com";
const USERNAME = process.env.SERVICENOW_USERNAME || "";
const PASSWORD = process.env.SERVICENOW_PASSWORD || "";
const SESSION_TOKEN = process.env.SERVICENOW_SESSION_TOKEN || "";
const USER_TOKEN = process.env.SERVICENOW_USER_TOKEN || "";

// Load browser auth cookies if available (mutable to allow hot-reload)
let browserAuth = loadCookies();

// Function to reload cookies without restarting the server
function reloadBrowserAuth(): boolean {
  const newAuth = loadCookies();
  if (newAuth) {
    browserAuth = newAuth;
    console.error("✅ Browser auth cookies reloaded successfully");
    return true;
  }
  console.error("❌ Failed to reload browser auth cookies");
  return false;
}

// HTTP client with connection pooling
import { Agent } from "node:https";
const httpsAgent = new Agent({ keepAlive: true, maxSockets: 10 });

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOLS: Tool[] = [
  // -------------------------------------------------------------------------
  // AUTHENTICATION
  // -------------------------------------------------------------------------
  {
    name: "auth_browser",
    description:
      "Launch browser for SSO authentication. Opens a browser window where you can log in with your enterprise SSO credentials. Cookies are captured and saved for subsequent API calls. Use this when you don't have API keys and need to use SSO.",
    inputSchema: {
      type: "object",
      properties: {
        instance_url: {
          type: "string",
          description:
            "ServiceNow instance URL (e.g., https://mycompany.service-now.com). If not provided, uses SERVICENOW_INSTANCE_URL env var.",
        },
      },
    },
  },
  {
    name: "auth_status",
    description:
      "Check current authentication status. Shows which auth method is configured and whether credentials/cookies are valid.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "auth_import_cookies",
    description:
      "Import authentication cookies from an external source. Use this when you already have an authenticated browser session (e.g., via Firefox DevTools) and want to transfer those credentials to the MCP. Extract cookies and x-usertoken from network request headers.",
    inputSchema: {
      type: "object",
      properties: {
        instance_url: {
          type: "string",
          description:
            "ServiceNow instance URL (e.g., https://mycompany.service-now.com)",
        },
        cookies: {
          type: "string",
          description:
            "Cookie header string from authenticated request (e.g., 'JSESSIONID=abc123; glide_user_route=xyz')",
        },
        user_token: {
          type: "string",
          description:
            "x-usertoken header value from authenticated request (optional but recommended for CSRF protection)",
        },
      },
      required: ["instance_url", "cookies"],
    },
  },
  {
    name: "auth_refresh",
    description:
      "Refresh the current session by re-authenticating via browser. Uses the previously authenticated instance URL. Useful when session has expired.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // -------------------------------------------------------------------------
  // UNIFIED WORK QUEUE (Priority tools for finding actionable items)
  // -------------------------------------------------------------------------
  {
    name: "my_context",
    description:
      "Get current user's identity, groups, and roles. Returns cached user info including sys_id, name, email, department, group memberships, and roles. Use this first to understand who you're working as.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "my_work_queue",
    description:
      "Get ALL actionable items for current user in a single call: assigned tasks, pending approvals, and unassigned group queue items. This is the recommended first tool to use when user asks 'what do I need to work on?' or 'what are my open tasks?'",
    inputSchema: {
      type: "object",
      properties: {
        include: {
          type: "array",
          items: {
            type: "string",
            enum: ["assigned", "approvals", "group_queue"],
          },
          description: "Which categories to include (default: all three)",
          default: ["assigned", "approvals", "group_queue"],
        },
        keyword: {
          type: "string",
          description:
            "Filter results by keyword in short_description (e.g., 'firewall', 'SAP')",
        },
        limit: {
          type: "number",
          description: "Max results per category (default 20)",
          default: 20,
        },
      },
    },
  },
  // -------------------------------------------------------------------------
  // INCIDENTS
  // -------------------------------------------------------------------------
  {
    name: "incidents_list",
    description:
      "List incidents with optional filtering. Returns incident number, short description, state, priority, assigned_to.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "ServiceNow encoded query (e.g., 'state=1^priority=1' for new P1s)",
        },
        limit: {
          type: "number",
          description: "Max results (default 20)",
          default: 20,
        },
        offset: {
          type: "number",
          description: "Pagination offset",
          default: 0,
        },
        fields: {
          type: "string",
          description: "Comma-separated fields to return",
        },
      },
    },
  },
  {
    name: "incidents_get",
    description: "Get a single incident by sys_id or number",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Incident sys_id or number (e.g., INC0012345)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "incidents_create",
    description: "Create a new incident",
    inputSchema: {
      type: "object",
      properties: {
        short_description: {
          type: "string",
          description: "Brief description of the issue",
        },
        description: { type: "string", description: "Detailed description" },
        caller_id: {
          type: "string",
          description: "User sys_id or email of the caller",
        },
        category: { type: "string", description: "Incident category" },
        subcategory: { type: "string", description: "Incident subcategory" },
        priority: { type: "number", description: "Priority 1-5 (1=Critical)" },
        assignment_group: {
          type: "string",
          description: "Assignment group sys_id or name",
        },
        cmdb_ci: { type: "string", description: "Configuration item sys_id" },
      },
      required: ["short_description"],
    },
  },
  {
    name: "incidents_update",
    description: "Update an existing incident",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Incident sys_id or number" },
        data: {
          type: "object",
          description:
            "Fields to update (state, priority, assigned_to, work_notes, etc.)",
          additionalProperties: true,
        },
      },
      required: ["id", "data"],
    },
  },
  {
    name: "incidents_add_comment",
    description: "Add a work note or comment to an incident",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Incident sys_id or number" },
        comment: { type: "string", description: "The comment/work note text" },
        type: {
          type: "string",
          enum: ["work_notes", "comments"],
          description: "work_notes (internal) or comments (customer visible)",
          default: "work_notes",
        },
      },
      required: ["id", "comment"],
    },
  },
  {
    name: "incidents_resolve",
    description: "Resolve an incident",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Incident sys_id or number" },
        resolution_code: { type: "string", description: "Resolution code" },
        resolution_notes: {
          type: "string",
          description: "Resolution notes/close notes",
        },
      },
      required: ["id", "resolution_notes"],
    },
  },

  // -------------------------------------------------------------------------
  // CHANGE REQUESTS
  // -------------------------------------------------------------------------
  {
    name: "changes_list",
    description: "List change requests with optional filtering",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "ServiceNow encoded query" },
        limit: { type: "number", default: 20 },
        offset: { type: "number", default: 0 },
        type: {
          type: "string",
          enum: ["standard", "normal", "emergency"],
          description: "Filter by change type",
        },
      },
    },
  },
  {
    name: "changes_get",
    description: "Get a single change request by sys_id or number",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Change request sys_id or number (e.g., CHG0012345)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "changes_create",
    description: "Create a new change request",
    inputSchema: {
      type: "object",
      properties: {
        short_description: { type: "string" },
        description: { type: "string" },
        type: { type: "string", enum: ["standard", "normal", "emergency"] },
        category: { type: "string" },
        assignment_group: { type: "string" },
        cmdb_ci: { type: "string" },
        start_date: {
          type: "string",
          description: "Planned start (ISO format)",
        },
        end_date: { type: "string", description: "Planned end (ISO format)" },
        justification: { type: "string" },
        implementation_plan: { type: "string" },
        backout_plan: { type: "string" },
        test_plan: { type: "string" },
      },
      required: ["short_description", "type"],
    },
  },
  {
    name: "changes_tasks",
    description: "Get tasks associated with a change request",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Change request sys_id or number" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // SERVICE CATALOG
  // -------------------------------------------------------------------------
  {
    name: "catalog_items",
    description: "List available service catalog items",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category sys_id or name",
        },
        query: { type: "string", description: "Search text" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "catalog_get",
    description: "Get details of a catalog item including variables/questions",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Catalog item sys_id" },
      },
      required: ["id"],
    },
  },
  {
    name: "catalog_order",
    description: "Order/submit a catalog item request",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Catalog item sys_id" },
        variables: {
          type: "object",
          description: "Variable values for the request",
          additionalProperties: true,
        },
        requested_for: {
          type: "string",
          description: "User sys_id (defaults to current user)",
        },
        quantity: { type: "number", default: 1 },
      },
      required: ["item_id"],
    },
  },
  {
    name: "requests_list",
    description:
      "List service requests (sc_request) for current user or with filter",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 20 },
        my_requests: {
          type: "boolean",
          description: "Only show my requests",
          default: true,
        },
      },
    },
  },
  {
    name: "requests_items",
    description: "List requested items (sc_req_item) with status",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 20 },
      },
    },
  },

  // -------------------------------------------------------------------------
  // CMDB
  // -------------------------------------------------------------------------
  {
    name: "cmdb_search",
    description: "Search CMDB configuration items",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text or encoded query" },
        class: {
          type: "string",
          description: "CI class (cmdb_ci_server, cmdb_ci_app, etc.)",
          default: "cmdb_ci",
        },
        limit: { type: "number", default: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "cmdb_get",
    description: "Get configuration item details",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "CI sys_id or name" },
        class: {
          type: "string",
          description: "CI class table",
          default: "cmdb_ci",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "cmdb_relationships",
    description: "Get relationships for a configuration item",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "CI sys_id" },
        direction: {
          type: "string",
          enum: ["parent", "child", "both"],
          default: "both",
        },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // PROBLEMS
  // -------------------------------------------------------------------------
  {
    name: "problems_list",
    description: "List problem records",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "problems_get",
    description: "Get a problem record",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Problem sys_id or number" },
      },
      required: ["id"],
    },
  },
  {
    name: "problems_create",
    description: "Create a problem record",
    inputSchema: {
      type: "object",
      properties: {
        short_description: { type: "string" },
        description: { type: "string" },
        category: { type: "string" },
        subcategory: { type: "string" },
        assignment_group: { type: "string" },
        cmdb_ci: { type: "string" },
      },
      required: ["short_description"],
    },
  },

  // -------------------------------------------------------------------------
  // KNOWLEDGE
  // -------------------------------------------------------------------------
  {
    name: "knowledge_search",
    description: "Search knowledge base articles",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        knowledge_base: {
          type: "string",
          description: "KB sys_id to search in",
        },
        limit: { type: "number", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "knowledge_get",
    description: "Get a knowledge article",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Article sys_id or number" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // USERS & GROUPS
  // -------------------------------------------------------------------------
  {
    name: "users_search",
    description: "Search for users",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name, email, or user_name to search",
        },
        limit: { type: "number", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "users_get",
    description: "Get user details",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "User sys_id, user_name, or email" },
      },
      required: ["id"],
    },
  },
  {
    name: "groups_list",
    description: "List groups",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Filter by name" },
        type: { type: "string", description: "Group type" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "groups_members",
    description: "Get members of a group",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Group sys_id or name" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // TASKS & APPROVALS
  // -------------------------------------------------------------------------
  {
    name: "tasks_my_tasks",
    description: "Get tasks assigned to current user",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "Filter by state (e.g., 'open', 'pending')",
        },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "tasks_update",
    description: "Update a task",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task sys_id or number" },
        data: { type: "object", additionalProperties: true },
      },
      required: ["id", "data"],
    },
  },
  {
    name: "approvals_pending",
    description:
      "Get pending approvals for current user with ENRICHED details from parent records. Returns number, short_description, opened_by, urgency, and stage - not just approval metadata. Supports keyword filtering.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description:
            "Filter by keyword in parent record's short_description (e.g., 'firewall', 'access')",
        },
        type: {
          type: "string",
          enum: ["all", "sc_req_item", "change_request", "sc_task"],
          description: "Filter by parent record type",
          default: "all",
        },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "approvals_approve",
    description: "Approve an approval request",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Approval sys_id" },
        comments: { type: "string", description: "Approval comments" },
      },
      required: ["id"],
    },
  },
  {
    name: "approvals_reject",
    description: "Reject an approval request",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Approval sys_id" },
        comments: { type: "string", description: "Rejection reason" },
      },
      required: ["id", "comments"],
    },
  },

  // -------------------------------------------------------------------------
  // ATTACHMENTS (Full API)
  // -------------------------------------------------------------------------
  {
    name: "attachment_list",
    description: "List attachments for a record",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        id: { type: "string", description: "Record sys_id" },
      },
      required: ["table", "id"],
    },
  },
  {
    name: "attachment_get",
    description: "Get attachment metadata by sys_id",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Attachment sys_id" },
      },
      required: ["id"],
    },
  },
  {
    name: "attachment_download",
    description:
      "Get attachment content (returns base64 encoded for binary files)",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Attachment sys_id" },
      },
      required: ["id"],
    },
  },
  {
    name: "attachment_upload",
    description: "Upload an attachment to a record",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Target table name" },
        id: { type: "string", description: "Target record sys_id" },
        filename: { type: "string", description: "File name" },
        content: {
          type: "string",
          description: "Base64 encoded file content",
        },
        content_type: {
          type: "string",
          description: "MIME type (e.g., application/pdf)",
          default: "application/octet-stream",
        },
      },
      required: ["table", "id", "filename", "content"],
    },
  },
  {
    name: "attachment_delete",
    description: "Delete an attachment",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Attachment sys_id" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // SERVICE CATALOG (Full sn_sc API)
  // -------------------------------------------------------------------------
  {
    name: "catalog_categories",
    description: "List service catalog categories",
    inputSchema: {
      type: "object",
      properties: {
        catalog_id: {
          type: "string",
          description: "Catalog sys_id (optional)",
        },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "catalog_item_variables",
    description:
      "Get variables/questions for a catalog item (required fields for ordering)",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Catalog item sys_id" },
      },
      required: ["id"],
    },
  },
  {
    name: "catalog_add_to_cart",
    description: "Add a catalog item to the shopping cart",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Catalog item sys_id" },
        quantity: { type: "number", default: 1 },
        variables: {
          type: "object",
          description: "Variable values for the item",
          additionalProperties: true,
        },
      },
      required: ["item_id"],
    },
  },
  {
    name: "catalog_get_cart",
    description: "Get current shopping cart contents",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "catalog_submit_cart",
    description: "Submit/checkout the shopping cart to create requests",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "catalog_order_now",
    description:
      "Order a catalog item immediately (skip cart, single-step order)",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Catalog item sys_id" },
        quantity: { type: "number", default: 1 },
        variables: {
          type: "object",
          description: "Variable values for the item",
          additionalProperties: true,
        },
        requested_for: {
          type: "string",
          description: "User sys_id to request for",
        },
      },
      required: ["item_id"],
    },
  },

  // -------------------------------------------------------------------------
  // IT SERVICE PORTAL (ITSP) HELPERS
  // -------------------------------------------------------------------------
  {
    name: "itsp_parse_url",
    description:
      "Parse an IT Service Portal (ITSP) URL to extract catalog item information. Extracts sys_id, table name, and instance URL from portal links like 'https://instance.service-now.com/itsp?id=sc_cat_item&sys_id=xxx'",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full ITSP URL from the portal",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "itsp_get_item_details",
    description:
      "Get full catalog item details from an ITSP URL. Automatically parses the URL and fetches item name, description, variables/questions, and all metadata needed for ordering.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "ITSP portal URL for the catalog item",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "itsp_submit_request",
    description:
      "Submit a service request directly from an ITSP URL. Streamlined workflow: parses URL, validates variables, and submits the request in one step.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "ITSP portal URL for the catalog item",
        },
        variables: {
          type: "object",
          description:
            "Variable values for the request (field name: value pairs)",
          additionalProperties: true,
        },
        requested_for: {
          type: "string",
          description: "User sys_id to request for (defaults to current user)",
        },
        quantity: {
          type: "number",
          description: "Quantity to request",
          default: 1,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "requests_get_details",
    description:
      "Get detailed information about a service request or requested item including status, variables, approval status, and activity history. Accepts REQ numbers (requests) or RITM numbers (requested items).",
    inputSchema: {
      type: "object",
      properties: {
        number: {
          type: "string",
          description:
            "Request number (REQ0010001), Requested Item number (RITM0010001), or sys_id",
        },
      },
      required: ["number"],
    },
  },
  {
    name: "requests_get_my_recent",
    description:
      "Get recent service requests for current user with full details. Returns last 10 requests with status, items, and approval information.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of recent requests to return",
          default: 10,
        },
      },
    },
  },
  {
    name: "record_producer_submit",
    description:
      "Submit a Record Producer request. Record Producers create records directly (like incidents) without using the cart. Use this for incident creation, problem reporting, and other single-record submissions from the service catalog.",
    inputSchema: {
      type: "object",
      properties: {
        producer_id: {
          type: "string",
          description: "Record Producer sys_id or catalog item sys_id",
        },
        variables: {
          type: "object",
          description: "Variable values for the record producer",
          additionalProperties: true,
        },
      },
      required: ["producer_id"],
    },
  },
  {
    name: "record_producer_get_details",
    description:
      "Get details about a Record Producer including its variables and target table. Helps understand what fields are needed before submission.",
    inputSchema: {
      type: "object",
      properties: {
        producer_id: {
          type: "string",
          description: "Record Producer sys_id",
        },
      },
      required: ["producer_id"],
    },
  },
  {
    name: "order_guide_submit",
    description:
      "Submit an Order Guide request. Order Guides bundle multiple catalog items into a single request, creating multiple requested items (RITMs). Use this for requesting multiple related items at once.",
    inputSchema: {
      type: "object",
      properties: {
        guide_id: {
          type: "string",
          description: "Order Guide sys_id",
        },
        items: {
          type: "array",
          description:
            "Array of items to include in the order guide, each with item_id and variables",
          items: {
            type: "object",
            properties: {
              item_id: { type: "string" },
              variables: { type: "object", additionalProperties: true },
              quantity: { type: "number", default: 1 },
            },
            required: ["item_id"],
          },
        },
        requested_for: {
          type: "string",
          description: "User sys_id to request for (defaults to current user)",
        },
      },
      required: ["guide_id", "items"],
    },
  },
  {
    name: "order_guide_get_details",
    description:
      "Get details about an Order Guide including available items, categories, and variables. Helps understand what items can be included before submission.",
    inputSchema: {
      type: "object",
      properties: {
        guide_id: {
          type: "string",
          description: "Order Guide sys_id",
        },
      },
      required: ["guide_id"],
    },
  },
  {
    name: "catalog_detect_item_type",
    description:
      "Automatically detect the type of catalog item (Standard, Record Producer, Order Guide, or Content). Returns the item type and appropriate submission method to use.",
    inputSchema: {
      type: "object",
      properties: {
        item_id: {
          type: "string",
          description: "Catalog item sys_id or ITSP URL",
        },
      },
      required: ["item_id"],
    },
  },

  // -------------------------------------------------------------------------
  // IMPORT SET API
  // -------------------------------------------------------------------------
  {
    name: "import_set_load",
    description: "Load data into an import set staging table",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Import set table name (e.g., u_my_import_set)",
        },
        data: {
          type: "object",
          description: "Data to import (single record)",
          additionalProperties: true,
        },
      },
      required: ["table", "data"],
    },
  },
  {
    name: "import_set_load_multiple",
    description: "Load multiple records into an import set staging table",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Import set table name",
        },
        records: {
          type: "array",
          items: { type: "object" },
          description: "Array of records to import",
        },
      },
      required: ["table", "records"],
    },
  },
  {
    name: "import_set_status",
    description: "Get status of an import set",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Import set sys_id" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // BATCH API
  // -------------------------------------------------------------------------
  {
    name: "batch_request",
    description: "Execute multiple API requests in a single call",
    inputSchema: {
      type: "object",
      properties: {
        requests: {
          type: "array",
          description: "Array of request objects",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Request identifier" },
              method: {
                type: "string",
                enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
              },
              url: { type: "string", description: "Relative URL path" },
              body: {
                type: "object",
                description: "Request body for POST/PUT",
              },
              headers: { type: "object", description: "Additional headers" },
            },
            required: ["id", "method", "url"],
          },
        },
      },
      required: ["requests"],
    },
  },

  // -------------------------------------------------------------------------
  // CMDB INSTANCE API (Advanced)
  // -------------------------------------------------------------------------
  {
    name: "cmdb_classes",
    description: "List CMDB CI classes/types",
    inputSchema: {
      type: "object",
      properties: {
        parent_class: {
          type: "string",
          description: "Parent class to filter by",
          default: "cmdb_ci",
        },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "cmdb_instance_list",
    description:
      "List CMDB instances by class (uses CMDB Instance API /now/cmdb/instance)",
    inputSchema: {
      type: "object",
      properties: {
        class_name: {
          type: "string",
          description:
            "CI class name (e.g., cmdb_ci_server, cmdb_ci_linux_server)",
        },
        query: { type: "string", description: "Filter query" },
        limit: { type: "number", default: 20 },
      },
      required: ["class_name"],
    },
  },
  {
    name: "cmdb_create",
    description: "Create a new CMDB configuration item",
    inputSchema: {
      type: "object",
      properties: {
        class_name: {
          type: "string",
          description: "CI class (e.g., cmdb_ci_server)",
        },
        data: {
          type: "object",
          description: "CI attributes",
          additionalProperties: true,
        },
      },
      required: ["class_name", "data"],
    },
  },
  {
    name: "cmdb_update",
    description: "Update a CMDB configuration item",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "CI sys_id" },
        class_name: { type: "string", description: "CI class" },
        data: { type: "object", additionalProperties: true },
      },
      required: ["id", "data"],
    },
  },
  {
    name: "cmdb_relationship_create",
    description: "Create a relationship between two CIs",
    inputSchema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "Parent CI sys_id" },
        child: { type: "string", description: "Child CI sys_id" },
        type: {
          type: "string",
          description: "Relationship type sys_id or name",
        },
      },
      required: ["parent", "child", "type"],
    },
  },

  // -------------------------------------------------------------------------
  // TASK SLA
  // -------------------------------------------------------------------------
  {
    name: "sla_list",
    description: "List SLA definitions",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "task_sla_list",
    description: "List task SLAs (SLA records attached to tasks)",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Task sys_id to get SLAs for",
        },
        query: { type: "string" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "task_sla_get",
    description: "Get task SLA details",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task SLA sys_id" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // WORKFLOW
  // -------------------------------------------------------------------------
  {
    name: "workflow_list",
    description: "List workflow definitions",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        active: { type: "boolean", default: true },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "workflow_context_list",
    description: "List workflow contexts (running workflow instances)",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Filter by table (e.g., incident)",
        },
        record_id: {
          type: "string",
          description: "Filter by record sys_id",
        },
        state: {
          type: "string",
          enum: ["executing", "finished", "cancelled"],
        },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "workflow_context_get",
    description: "Get workflow context details",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Workflow context sys_id" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // EMAIL / NOTIFICATIONS
  // -------------------------------------------------------------------------
  {
    name: "email_list",
    description: "List emails (sys_email table)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: {
          type: "string",
          enum: ["sent", "received", "send-ready", "draft"],
        },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "email_get",
    description: "Get email details",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Email sys_id" },
      },
      required: ["id"],
    },
  },
  {
    name: "notification_list",
    description: "List email notification rules",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Filter by table" },
        active: { type: "boolean", default: true },
        limit: { type: "number", default: 20 },
      },
    },
  },

  // -------------------------------------------------------------------------
  // EVENTS
  // -------------------------------------------------------------------------
  {
    name: "event_list",
    description: "List system events (sysevent)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        name: { type: "string", description: "Event name filter" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "event_create",
    description: "Create/fire a system event",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Event name" },
        instance: {
          type: "string",
          description: "Record sys_id (parm1)",
        },
        parm2: { type: "string", description: "Parameter 2" },
        table: { type: "string", description: "Table name" },
      },
      required: ["name"],
    },
  },

  // -------------------------------------------------------------------------
  // JOURNAL / ACTIVITY STREAM
  // -------------------------------------------------------------------------
  {
    name: "journal_list",
    description: "List journal entries (work notes, comments) for a record",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        id: { type: "string", description: "Record sys_id" },
        type: {
          type: "string",
          enum: ["work_notes", "comments", "all"],
          default: "all",
        },
        limit: { type: "number", default: 50 },
      },
      required: ["table", "id"],
    },
  },
  {
    name: "activity_stream",
    description: "Get activity stream for a record (all changes, comments)",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        id: { type: "string", description: "Record sys_id" },
        limit: { type: "number", default: 50 },
      },
      required: ["table", "id"],
    },
  },

  // -------------------------------------------------------------------------
  // AUDIT / HISTORY
  // -------------------------------------------------------------------------
  {
    name: "audit_list",
    description: "List audit history for a record",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        id: { type: "string", description: "Record sys_id" },
        limit: { type: "number", default: 50 },
      },
      required: ["table", "id"],
    },
  },

  // -------------------------------------------------------------------------
  // SCHEDULED JOBS
  // -------------------------------------------------------------------------
  {
    name: "scheduled_job_list",
    description: "List scheduled jobs",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        active: { type: "boolean", default: true },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "scheduled_job_run",
    description: "Execute a scheduled job immediately",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Scheduled job sys_id" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // METRICS / PERFORMANCE ANALYTICS
  // -------------------------------------------------------------------------
  {
    name: "metric_list",
    description: "List defined metrics",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "metric_data",
    description: "Get metric data/values",
    inputSchema: {
      type: "object",
      properties: {
        metric_id: { type: "string", description: "Metric sys_id" },
        start_date: { type: "string", description: "Start date (ISO)" },
        end_date: { type: "string", description: "End date (ISO)" },
      },
      required: ["metric_id"],
    },
  },

  // -------------------------------------------------------------------------
  // UPDATE SETS
  // -------------------------------------------------------------------------
  {
    name: "update_set_list",
    description: "List update sets",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        state: {
          type: "string",
          enum: ["in progress", "complete", "ignore"],
        },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "update_set_get",
    description: "Get update set details with customer updates",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Update set sys_id" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // ASSET MANAGEMENT (ITAM)
  // -------------------------------------------------------------------------
  {
    name: "asset_list",
    description: "List assets (alm_asset)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        asset_tag: { type: "string", description: "Filter by asset tag" },
        state: {
          type: "string",
          enum: ["in_stock", "in_use", "on_order", "retired", "disposed"],
        },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "asset_get",
    description: "Get asset details",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Asset sys_id or asset_tag" },
      },
      required: ["id"],
    },
  },
  {
    name: "asset_create",
    description: "Create an asset",
    inputSchema: {
      type: "object",
      properties: {
        asset_tag: { type: "string" },
        display_name: { type: "string" },
        model_category: { type: "string" },
        model: { type: "string", description: "Model sys_id" },
        serial_number: { type: "string" },
        assigned_to: { type: "string" },
        cost: { type: "number" },
        purchase_date: { type: "string" },
      },
      required: ["display_name"],
    },
  },
  {
    name: "asset_update",
    description: "Update an asset",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Asset sys_id" },
        data: { type: "object", additionalProperties: true },
      },
      required: ["id", "data"],
    },
  },

  // -------------------------------------------------------------------------
  // SOFTWARE LICENSE MANAGEMENT
  // -------------------------------------------------------------------------
  {
    name: "license_list",
    description: "List software licenses (alm_license)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        product: { type: "string", description: "Software product name" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "license_get",
    description: "Get software license details",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "License sys_id" },
      },
      required: ["id"],
    },
  },
  {
    name: "license_entitlements",
    description: "List license entitlements/allocations",
    inputSchema: {
      type: "object",
      properties: {
        license_id: { type: "string", description: "License sys_id" },
        limit: { type: "number", default: 50 },
      },
    },
  },

  // -------------------------------------------------------------------------
  // SOFTWARE ASSET MANAGEMENT
  // -------------------------------------------------------------------------
  {
    name: "software_list",
    description: "List software installations",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        publisher: { type: "string" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "software_product_list",
    description: "List software products (software catalog)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        vendor: { type: "string" },
        limit: { type: "number", default: 20 },
      },
    },
  },

  // -------------------------------------------------------------------------
  // CONTRACTS
  // -------------------------------------------------------------------------
  {
    name: "contract_list",
    description: "List contracts",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", description: "Contract type" },
        state: { type: "string" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "contract_get",
    description: "Get contract details",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Contract sys_id" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // LOCATION
  // -------------------------------------------------------------------------
  {
    name: "location_list",
    description: "List locations",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", description: "Location type" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "location_get",
    description: "Get location details",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Location sys_id or name" },
      },
      required: ["id"],
    },
  },

  // -------------------------------------------------------------------------
  // DEPARTMENT / COST CENTER
  // -------------------------------------------------------------------------
  {
    name: "department_list",
    description: "List departments",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "cost_center_list",
    description: "List cost centers",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 50 },
      },
    },
  },

  // -------------------------------------------------------------------------
  // DISCOVERY / ITOM
  // -------------------------------------------------------------------------
  {
    name: "discovery_status_list",
    description: "List discovery status records",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        state: { type: "string", enum: ["active", "completed", "cancelled"] },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "discovery_schedule_list",
    description: "List discovery schedules",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        active: { type: "boolean", default: true },
        limit: { type: "number", default: 20 },
      },
    },
  },

  // -------------------------------------------------------------------------
  // SECURITY / ACL
  // -------------------------------------------------------------------------
  {
    name: "acl_list",
    description: "List access control rules",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Filter by table" },
        operation: {
          type: "string",
          enum: ["read", "write", "create", "delete"],
        },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "role_list",
    description: "List roles",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "user_roles",
    description: "Get roles for a user",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "User sys_id" },
      },
      required: ["user_id"],
    },
  },

  // -------------------------------------------------------------------------
  // GENERIC / UTILITIES
  // -------------------------------------------------------------------------
  {
    name: "table_query",
    description: "Generic table query - query any ServiceNow table",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Table name (e.g., incident, sys_user, cmdb_ci)",
        },
        query: { type: "string", description: "Encoded query string" },
        fields: {
          type: "string",
          description: "Comma-separated fields to return",
        },
        limit: { type: "number", default: 20 },
        offset: { type: "number", default: 0 },
        order_by: { type: "string", description: "Field to order by" },
        order_dir: { type: "string", enum: ["asc", "desc"], default: "desc" },
      },
      required: ["table"],
    },
  },
  {
    name: "table_get",
    description: "Get a single record from any table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        id: { type: "string", description: "Record sys_id" },
        fields: { type: "string", description: "Comma-separated fields" },
      },
      required: ["table", "id"],
    },
  },
  {
    name: "table_create",
    description: "Create a record in any table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        data: { type: "object", additionalProperties: true },
      },
      required: ["table", "data"],
    },
  },
  {
    name: "table_update",
    description: "Update a record in any table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        id: { type: "string", description: "Record sys_id" },
        data: { type: "object", additionalProperties: true },
      },
      required: ["table", "id", "data"],
    },
  },
  {
    name: "table_delete",
    description: "Delete a record from any table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        id: { type: "string", description: "Record sys_id" },
      },
      required: ["table", "id"],
    },
  },
  {
    name: "aggregate",
    description: "Run aggregate queries (count, sum, avg, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        query: { type: "string", description: "Filter query" },
        group_by: { type: "string", description: "Field to group by" },
        aggregate: {
          type: "string",
          enum: ["COUNT", "SUM", "AVG", "MIN", "MAX"],
          default: "COUNT",
        },
        having: { type: "string", description: "Having clause" },
      },
      required: ["table"],
    },
  },
  {
    name: "table_schema",
    description: "Get table schema/dictionary information",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
      },
      required: ["table"],
    },
  },
  {
    name: "choice_list",
    description: "Get choice list values for a field",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        field: { type: "string", description: "Field name" },
      },
      required: ["table", "field"],
    },
  },
];

// ============================================================================
// ServiceNow API Client
// ============================================================================

class ServiceNowClient {
  private baseUrl: string;
  private authHeader: string;
  private sessionCookies: string;
  private userToken: string;
  private authMethod: "browser" | "basic" | "session" | "none";
  private authManager: BrowserAuthManager | null = null;

  constructor() {
    // Priority: Browser auth > Basic auth > Session tokens
    if (browserAuth) {
      // Use browser-captured cookies
      this.baseUrl = browserAuth.instanceUrl;
      this.authHeader = "";
      this.sessionCookies = browserAuth.cookies;
      this.userToken = browserAuth.userToken;
      this.authMethod = "browser";
      // Initialize auto-renewing auth manager
      this.authManager = new BrowserAuthManager(
        "servicenow",
        browserAuth.instanceUrl,
        browserAuth.instanceUrl,
      );
      console.error("Using browser-based SSO authentication with auto-renewal");
    } else if (USERNAME && PASSWORD) {
      // Basic auth for REST Table API
      this.baseUrl = INSTANCE_URL.replace(/\/$/, "");
      this.authHeader =
        "Basic " + Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");
      this.sessionCookies = "";
      this.userToken = "";
      this.authMethod = "basic";
    } else if (SESSION_TOKEN) {
      // Session-based auth for GraphQL
      this.baseUrl = INSTANCE_URL.replace(/\/$/, "");
      this.authHeader = "";
      this.sessionCookies = SESSION_TOKEN;
      this.userToken = USER_TOKEN;
      this.authMethod = "session";
    } else {
      // No auth configured - MCP will still start but tools will prompt for auth
      this.baseUrl = INSTANCE_URL.replace(/\/$/, "");
      this.authHeader = "";
      this.sessionCookies = "";
      this.userToken = "";
      this.authMethod = "none";
    }
  }

  getAuthStatus(): {
    method: string;
    configured: boolean;
    instanceUrl: string;
    details: string;
  } {
    return {
      method: this.authMethod,
      configured: this.authMethod !== "none",
      instanceUrl: this.baseUrl || "(not set)",
      details:
        this.authMethod === "browser"
          ? "Using SSO cookies from browser authentication"
          : this.authMethod === "basic"
            ? "Using username/password basic auth"
            : this.authMethod === "session"
              ? "Using session token auth"
              : "No authentication configured. Use auth_browser tool or set credentials.",
    };
  }

  // Reload browser auth cookies (called when 401 is received)
  reloadCredentials(): boolean {
    if (this.authMethod !== "browser") {
      return false;
    }

    if (reloadBrowserAuth() && browserAuth) {
      this.baseUrl = browserAuth.instanceUrl;
      this.sessionCookies = browserAuth.cookies;
      this.userToken = browserAuth.userToken;
      console.error("✅ ServiceNowClient credentials reloaded");
      return true;
    }
    return false;
  }

  // Validate session by making a lightweight API call
  async validateSession(): Promise<{ valid: boolean; error?: string }> {
    try {
      const url = `${this.baseUrl}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id`;
      const authHeaders = await getAuthHeaders();
      const response = await fetch(url, { method: "GET", headers: { ...authHeaders } });
      if (response.status === 401) {
        return { valid: false, error: "Session expired (401 Unauthorized)" };
      }
      return { valid: response.ok };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Validation failed",
      };
    }
  }

  private checkConfig(): void {
    if (!this.baseUrl) {
      throw new Error(
        "ServiceNow not configured. Set SERVICENOW_INSTANCE_URL environment variable.\n" +
          "Example: https://yourinstance.service-now.com",
      );
    }
  }

  private async request(
    method: string,
    endpoint: string,
    body?: unknown,
    useGraphQL = false,
  ): Promise<unknown> {
    this.checkConfig();

    const url = `${this.baseUrl}${endpoint}`;
    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    // Auto-retry wrapper for browser auth
    const makeAuthenticatedRequest = async (retries = 1): Promise<unknown> => {
      const headers = { ...baseHeaders };

      // Apply authentication based on method
      if (this.authMethod === "browser") {
        // Use clean auth module: keychain → headless Playwright → cookies + g_ck
        const authHeaders = await getAuthHeaders();
        Object.assign(headers, authHeaders);
      } else if (useGraphQL && this.userToken) {
        headers["x-usertoken"] = this.userToken;
        if (this.sessionCookies) {
          headers["Cookie"] = this.sessionCookies;
        }
      } else if (this.authHeader) {
        headers["Authorization"] = this.authHeader;
      } else {
        // No explicit auth configured — try getAuthHeaders() as last resort
        try {
          const authHeaders = await getAuthHeaders();
          Object.assign(headers, authHeaders);
          this.authMethod = "browser";
        } catch {
          throw new Error(
            "No authentication configured. Options:\n" +
              "1. Add corp-sso-email and corp-sso-password to macOS Keychain\n" +
              "2. Set SERVICENOW_USERNAME + SERVICENOW_PASSWORD (for REST API)\n" +
              "3. Set SERVICENOW_SESSION_TOKEN + SERVICENOW_USER_TOKEN (for session auth)",
          );
        }
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle auth errors
      if (
        (response.status === 401 || response.status === 403) &&
        retries > 0
      ) {
        if (this.authMethod === "basic") {
          // Basic auth failed — try falling back to cookie-based auth from host
          console.error(
            `⚠️  Basic auth failed (${response.status}). Trying cookie-based auth from host...`,
          );
          clearAuthCache();
          const authHeaders = await getAuthHeaders();
          if (authHeaders.Cookie) {
            this.authMethod = "browser";
            this.authHeader = "";
            return makeAuthenticatedRequest(retries - 1);
          }
        } else if (this.authMethod === "browser") {
          // Cookie auth failed — clear local cache and re-read host file (may have been refreshed externally)
          console.error(
            `⚠️  Cookie auth failed (${response.status}). Clearing local cache, re-reading host cookies...`,
          );
          clearAuthCache();
          const freshHeaders = await getAuthHeaders();
          if (freshHeaders.Cookie) {
            return makeAuthenticatedRequest(retries - 1);
          }
          // Host cookies also stale — need host re-auth
          const errorText = await response.text().catch(() => "");
          throw new Error(
            `ServiceNow session expired (${response.status}). Run host-auth to re-authenticate:\n` +
            `  cd ~/Scripts/mcp-servers/servicenow-mcp && node scripts/host-auth.mjs\n` +
            errorText,
          );
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `ServiceNow API error ${response.status}: ${errorText}`,
        );
      }

      return response.json();
    };

    return makeAuthenticatedRequest();
  }

  // REST Table API methods
  async tableQuery(
    table: string,
    params: {
      query?: string;
      fields?: string;
      limit?: number;
      offset?: number;
      orderBy?: string;
      orderDir?: string;
    },
  ): Promise<unknown> {
    const searchParams = new URLSearchParams();
    if (params.query) searchParams.set("sysparm_query", params.query);
    if (params.fields) searchParams.set("sysparm_fields", params.fields);
    if (params.limit) searchParams.set("sysparm_limit", String(params.limit));
    if (params.offset)
      searchParams.set("sysparm_offset", String(params.offset));
    if (params.orderBy) {
      const dir = params.orderDir === "asc" ? "" : "DESC";
      searchParams.set(
        "sysparm_query",
        `${params.query || ""}^ORDERBY${dir}${params.orderBy}`,
      );
    }
    searchParams.set("sysparm_display_value", "true");

    return this.request(
      "GET",
      `/api/now/table/${table}?${searchParams.toString()}`,
    );
  }

  async tableGet(table: string, id: string, fields?: string): Promise<unknown> {
    const searchParams = new URLSearchParams();
    if (fields) searchParams.set("sysparm_fields", fields);
    searchParams.set("sysparm_display_value", "true");

    return this.request(
      "GET",
      `/api/now/table/${table}/${id}?${searchParams.toString()}`,
    );
  }

  async tableCreate(
    table: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request("POST", `/api/now/table/${table}`, data);
  }

  async tableUpdate(
    table: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request("PATCH", `/api/now/table/${table}/${id}`, data);
  }

  async aggregate(
    table: string,
    params: {
      query?: string;
      groupBy?: string;
      aggregate?: string;
    },
  ): Promise<unknown> {
    const searchParams = new URLSearchParams();
    if (params.query) searchParams.set("sysparm_query", params.query);
    if (params.groupBy) searchParams.set("sysparm_group_by", params.groupBy);
    searchParams.set("sysparm_count", "true");

    return this.request(
      "GET",
      `/api/now/stats/${table}?${searchParams.toString()}`,
    );
  }

  // GraphQL API for session-based queries
  async graphqlQuery(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(
      "POST",
      "/api/now/graphql",
      {
        operationName,
        query,
        variables,
        cacheable: false,
      },
      true,
    );
  }

  // Resolve number to sys_id for incidents, changes, etc.
  async resolveId(table: string, id: string): Promise<string> {
    if (!id) {
      throw new Error(`ID is required for ${table} lookup`);
    }

    if (id.length === 32 && /^[a-f0-9]+$/.test(id)) {
      return id; // Already a sys_id
    }

    // Look up by number
    const numberField = this.getNumberField(table);
    const result = (await this.tableQuery(table, {
      query: `${numberField}=${id}`,
      fields: "sys_id",
      limit: 1,
    })) as { result?: Array<{ sys_id: string }> };

    if (result?.result && result.result.length > 0) {
      return result.result[0].sys_id;
    }
    throw new Error(`Could not find ${table} with ${numberField}=${id}`);
  }

  private getNumberField(table: string): string {
    const numberFields: Record<string, string> = {
      incident: "number",
      change_request: "number",
      problem: "number",
      sc_request: "number",
      sc_req_item: "number",
      kb_knowledge: "number",
      task: "number",
    };
    return numberFields[table] || "number";
  }

  // Delete a record
  async tableDelete(table: string, id: string): Promise<unknown> {
    return this.request("DELETE", `/api/now/table/${table}/${id}`);
  }

  // Attachment API
  async attachmentGet(id: string): Promise<unknown> {
    return this.request("GET", `/api/now/attachment/${id}`);
  }

  async attachmentDownload(id: string): Promise<unknown> {
    // Returns file content
    return this.request("GET", `/api/now/attachment/${id}/file`);
  }

  async attachmentUpload(
    table: string,
    recordId: string,
    filename: string,
    content: string,
    contentType: string,
  ): Promise<unknown> {
    this.checkConfig();
    const url = `${this.baseUrl}/api/now/attachment/file?table_name=${table}&table_sys_id=${recordId}&file_name=${encodeURIComponent(filename)}`;

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      Accept: "application/json",
    };

    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    // Decode base64 content
    const binaryContent = Buffer.from(content, "base64");

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: binaryContent,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Attachment upload error ${response.status}: ${errorText}`,
      );
    }

    return response.json();
  }

  async attachmentDelete(id: string): Promise<unknown> {
    return this.request("DELETE", `/api/now/attachment/${id}`);
  }

  // Service Catalog API (sn_sc)
  async catalogAddToCart(
    itemId: string,
    quantity: number,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/sn_sc/servicecatalog/items/${itemId}/add_to_cart`,
      { sysparm_quantity: quantity, variables },
    );
  }

  async catalogGetCart(): Promise<unknown> {
    return this.request("GET", "/api/sn_sc/servicecatalog/cart");
  }

  async catalogSubmitCart(): Promise<unknown> {
    return this.request("POST", "/api/sn_sc/servicecatalog/cart/submit_order");
  }

  async catalogOrderNow(
    itemId: string,
    quantity: number,
    variables: Record<string, unknown>,
    requestedFor?: string,
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      sysparm_quantity: quantity,
      variables,
    };
    if (requestedFor) body.sysparm_requested_for = requestedFor;

    return this.request(
      "POST",
      `/api/sn_sc/servicecatalog/items/${itemId}/order_now`,
      body,
    );
  }

  async catalogGetVariables(itemId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/api/sn_sc/servicecatalog/items/${itemId}/variables`,
    );
  }

  // IT Service Portal (ITSP) Helpers
  parseItspUrl(url: string): {
    sys_id: string;
    table: string;
    instance_url: string;
  } {
    try {
      const urlObj = new URL(url);
      const params = new URLSearchParams(urlObj.search);

      const sys_id = params.get("sys_id");
      const table = params.get("id") || "sc_cat_item";
      const instance_url = `${urlObj.protocol}//${urlObj.host}`;

      if (!sys_id) {
        throw new Error("No sys_id found in ITSP URL");
      }

      return { sys_id, table, instance_url };
    } catch (error) {
      throw new Error(
        `Invalid ITSP URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async itspGetItemDetails(url: string): Promise<unknown> {
    const { sys_id, table } = this.parseItspUrl(url);

    // Get catalog item details
    const item = await this.tableGet(table, sys_id);

    // Get variables/questions for the item
    const variables = await this.catalogGetVariables(sys_id);

    return {
      item,
      variables,
      parsed_url: { sys_id, table },
    };
  }

  async itspSubmitRequest(
    url: string,
    variables: Record<string, unknown>,
    requestedFor?: string,
    quantity?: number,
  ): Promise<unknown> {
    const { sys_id } = this.parseItspUrl(url);

    // Use catalog_order_now for direct submission
    return this.catalogOrderNow(sys_id, quantity || 1, variables, requestedFor);
  }

  async requestsGetDetails(number: string): Promise<unknown> {
    if (!number) {
      throw new Error("Request/Item number is required");
    }

    // Detect if this is a RITM (requested item) or REQ (request)
    const isRitm =
      number.toUpperCase().startsWith("RITM") ||
      number.toUpperCase().startsWith("SC_REQ_ITEM");

    if (isRitm) {
      // Handle RITM (Requested Item) numbers
      return this.getRequestedItemDetails(number);
    } else {
      // Handle REQ (Request) numbers
      return this.getRequestDetails(number);
    }
  }

  private async getRequestedItemDetails(ritmNumber: string): Promise<unknown> {
    // Resolve RITM number to sys_id
    const ritmId = await this.resolveId("sc_req_item", ritmNumber);

    // Get requested item details
    const item = await this.tableGet("sc_req_item", ritmId);

    // Get variables for this requested item
    const variablesResult = (await this.tableQuery("sc_item_option_mtom", {
      query: `request_item=${ritmId}`,
      fields:
        "sc_item_option.item_option_new.question_text,sc_item_option.value",
      limit: 100,
    })) as { result?: Array<Record<string, unknown>> };

    // Parse variables into a cleaner format
    const variables: Record<string, string> = {};
    if (variablesResult?.result) {
      for (const v of variablesResult.result) {
        const questionText =
          (v["sc_item_option.item_option_new.question_text"] as string) ||
          "Unknown";
        const value = (v["sc_item_option.value"] as string) || "";
        variables[questionText] = value;
      }
    }

    // Get approval records for this item
    const approvals = await this.tableQuery("sysapproval_approver", {
      query: `sysapproval=${ritmId}`,
      fields: "state,approver,comments,sys_created_on",
    });

    // Get activity history
    const activities = await this.tableQuery("sys_journal_field", {
      query: `element_id=${ritmId}`,
      fields: "element,value,sys_created_on,sys_created_by",
      limit: 20,
    });

    return {
      type: "requested_item",
      item,
      variables,
      approvals,
      activities,
    };
  }

  private async getRequestDetails(reqNumber: string): Promise<unknown> {
    // Resolve request number to sys_id
    const requestId = await this.resolveId("sc_request", reqNumber);

    // Get request details
    const request = await this.tableGet("sc_request", requestId);

    // Get requested items
    const items = await this.tableQuery("sc_req_item", {
      query: `request=${requestId}`,
      fields: "number,short_description,stage,state,cat_item,quantity",
    });

    // Get approval records
    const approvals = await this.tableQuery("sysapproval_approver", {
      query: `sysapproval=${requestId}`,
      fields: "state,approver,comments,sys_created_on",
    });

    // Get activity history
    const activities = await this.tableQuery("sys_journal_field", {
      query: `element_id=${requestId}`,
      fields: "element,value,sys_created_on,sys_created_by",
      limit: 20,
    });

    return {
      type: "request",
      request,
      items,
      approvals,
      activities,
    };
  }

  async requestsGetMyRecent(limit: number = 10): Promise<unknown> {
    const requests = await this.tableQuery("sc_request", {
      query: "requested_forDYNAMIC90d1921e5f510100a9ad2572f2b477fe",
      fields:
        "number,short_description,request_state,opened_at,requested_for,stage",
      limit,
      orderBy: "sys_created_on DESC",
    });

    // For each request, get items summary
    const results = [];
    for (const req of (requests as any).result || []) {
      const items = await this.tableQuery("sc_req_item", {
        query: `request=${req.sys_id}`,
        fields: "number,short_description,state",
        limit: 5,
      });

      results.push({
        ...req,
        items: (items as any).result || [],
      });
    }

    return { result: results };
  }

  // Record Producer support
  async recordProducerSubmit(
    producerId: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    // Record Producers use the same endpoint as catalog items but don't use cart
    // They directly create records in the target table
    return this.request(
      "POST",
      `/api/sn_sc/servicecatalog/items/${producerId}/submit_producer`,
      { variables },
    );
  }

  async recordProducerGetDetails(producerId: string): Promise<unknown> {
    // Get the catalog item details
    const item = await this.tableGet("sc_cat_item_producer", producerId);

    // Get variables for the producer
    const variables = await this.catalogGetVariables(producerId);

    return {
      item,
      variables,
      type: "record_producer",
    };
  }

  // Order Guide support
  async orderGuideSubmit(
    guideId: string,
    items: Array<{
      item_id: string;
      variables: Record<string, unknown>;
      quantity?: number;
    }>,
    requestedFor?: string,
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      items: items.map((item) => ({
        sys_id: item.item_id,
        quantity: item.quantity || 1,
        variables: item.variables,
      })),
    };
    if (requestedFor) body.requested_for = requestedFor;

    return this.request(
      "POST",
      `/api/sn_sc/servicecatalog/items/${guideId}/submit_guide`,
      body,
    );
  }

  async orderGuideGetDetails(guideId: string): Promise<unknown> {
    // Get the order guide details
    const guide = await this.tableGet("sc_cat_item_guide", guideId);

    // Get available items in the guide
    const items = await this.tableQuery("sc_cat_item_guide_items", {
      query: `guide=${guideId}`,
      fields: "cat_item,name,mandatory",
    });

    return {
      guide,
      items: (items as any).result || [],
      type: "order_guide",
    };
  }

  // Detect catalog item type
  async catalogDetectItemType(itemId: string): Promise<{
    type: "standard" | "record_producer" | "order_guide" | "content";
    item: unknown;
    submission_method: string;
  }> {
    // If it's a URL, parse it first
    let sys_id = itemId;
    if (itemId.startsWith("http")) {
      const parsed = this.parseItspUrl(itemId);
      sys_id = parsed.sys_id;
    }

    // Get the catalog item
    const item = await this.tableGet("sc_cat_item", sys_id);
    const itemData = item as any;

    // Check the type field or class
    let type: "standard" | "record_producer" | "order_guide" | "content" =
      "standard";
    let submission_method = "catalog_order_now";

    // Check if it's a record producer
    if (
      itemData.sys_class_name === "sc_cat_item_producer" ||
      itemData.type === "record_producer"
    ) {
      type = "record_producer";
      submission_method = "record_producer_submit";
    }
    // Check if it's an order guide
    else if (
      itemData.sys_class_name === "sc_cat_item_guide" ||
      itemData.type === "order_guide"
    ) {
      type = "order_guide";
      submission_method = "order_guide_submit";
    }
    // Check if it's content only
    else if (itemData.type === "content" || itemData.no_cart === "true") {
      type = "content";
      submission_method = "none";
    }

    return {
      type,
      item: itemData,
      submission_method,
    };
  }

  // Import Set API
  async importSetLoad(
    table: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request("POST", `/api/now/import/${table}`, data);
  }

  async importSetLoadMultiple(
    table: string,
    records: Array<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.request("POST", `/api/now/import/${table}/insertMultiple`, {
      records,
    });
  }

  // Batch API
  async batchRequest(
    requests: Array<{
      id: string;
      method: string;
      url: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    }>,
  ): Promise<unknown> {
    return this.request("POST", "/api/now/v1/batch", {
      batch_request_id: `batch_${Date.now()}`,
      rest_requests: requests.map((r) => ({
        id: r.id,
        method: r.method,
        url: r.url,
        body: r.body ? JSON.stringify(r.body) : undefined,
        headers: r.headers
          ? Object.entries(r.headers).map(([name, value]) => ({ name, value }))
          : [],
      })),
    });
  }

  // CMDB Instance API
  async cmdbInstanceList(
    className: string,
    query?: string,
    limit?: number,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (query) params.set("sysparm_query", query);
    if (limit) params.set("sysparm_limit", String(limit));

    return this.request(
      "GET",
      `/api/now/cmdb/instance/${className}?${params.toString()}`,
    );
  }

  // =========================================================================
  // UNIFIED WORK QUEUE METHODS (P1-P4 optimizations)
  // =========================================================================

  // Cache for user context (valid for session duration)
  private userContextCache: {
    user: Record<string, unknown>;
    groups: Array<{ sys_id: string; name: string }>;
    roles: string[];
  } | null = null;

  async getMyContext(): Promise<{
    user: Record<string, unknown>;
    groups: Array<{ sys_id: string; name: string }>;
    roles: string[];
  }> {
    // Return cached if available
    if (this.userContextCache) {
      return this.userContextCache;
    }

    // Get current user info
    const userResult = (await this.request(
      "GET",
      "/api/now/table/sys_user?sysparm_query=user_name=javascript:gs.getUserName()&sysparm_limit=1&sysparm_fields=sys_id,user_name,name,email,title,department,manager",
    )) as { result: Array<Record<string, unknown>> };

    const user = userResult.result?.[0] || {};
    const userId = user.sys_id as string;

    // Get user's group memberships (need both sys_id and display name)
    const groupsResult = (await this.request(
      "GET",
      `/api/now/table/sys_user_grmember?sysparm_query=user=${userId}&sysparm_fields=group&sysparm_display_value=all`,
    )) as {
      result: Array<{ group: { display_value: string; value: string } }>;
    };

    const groups = (groupsResult.result || []).map((g) => ({
      sys_id: g.group?.value || "",
      name: g.group?.display_value || "",
    }));

    // Get user's roles
    const rolesResult = (await this.request(
      "GET",
      `/api/now/table/sys_user_has_role?sysparm_query=user=${userId}&sysparm_fields=role&sysparm_display_value=true`,
    )) as { result: Array<{ role: { display_value: string } }> };

    const roles = (rolesResult.result || []).map(
      (r) => r.role?.display_value || "",
    );

    // Cache and return
    this.userContextCache = { user, groups, roles };
    return this.userContextCache;
  }

  async getMyWorkQueue(params: {
    include?: string[];
    keyword?: string;
    limit?: number;
  }): Promise<{
    assigned: unknown[];
    approvals: unknown[];
    group_queue: unknown[];
    summary: {
      total: number;
      assigned: number;
      approvals: number;
      group_queue: number;
    };
  }> {
    const include = params.include || ["assigned", "approvals", "group_queue"];
    const limit = params.limit || 20;
    const keyword = params.keyword;

    const results: {
      assigned: unknown[];
      approvals: unknown[];
      group_queue: unknown[];
    } = {
      assigned: [],
      approvals: [],
      group_queue: [],
    };

    // Build keyword filter
    const keywordFilter = keyword ? `^short_descriptionLIKE${keyword}` : "";

    // 1. Get assigned tasks (if requested)
    if (include.includes("assigned")) {
      const assignedResult = (await this.tableQuery("task", {
        query: `assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe^active=true${keywordFilter}`,
        fields:
          "number,short_description,state,priority,sys_class_name,sys_updated_on,assignment_group",
        limit,
      })) as { result: unknown[] };
      results.assigned = assignedResult.result || [];
    }

    // 2. Get pending approvals with enriched parent data (if requested)
    if (include.includes("approvals")) {
      results.approvals = await this.getEnrichedApprovals({ keyword, limit });
    }

    // 3. Get unassigned group queue items (if requested)
    if (include.includes("group_queue")) {
      const context = await this.getMyContext();
      const groupIds = context.groups.map((g) => g.sys_id).join(",");

      if (groupIds) {
        const groupQueueResult = (await this.tableQuery("task", {
          query: `assignment_groupIN${groupIds}^assigned_toISEMPTY^active=true${keywordFilter}`,
          fields:
            "number,short_description,state,priority,sys_class_name,assignment_group,sys_created_on",
          limit,
        })) as { result: unknown[] };
        results.group_queue = groupQueueResult.result || [];
      }
    }

    return {
      ...results,
      summary: {
        total:
          results.assigned.length +
          results.approvals.length +
          results.group_queue.length,
        assigned: results.assigned.length,
        approvals: results.approvals.length,
        group_queue: results.group_queue.length,
      },
    };
  }

  async getEnrichedApprovals(params: {
    keyword?: string;
    type?: string;
    limit?: number;
  }): Promise<unknown[]> {
    const limit = params.limit || 20;

    // Get pending approvals
    const approvalsResult = (await this.tableQuery("sysapproval_approver", {
      query: "approverDYNAMIC90d1921e5f510100a9ad2572f2b477fe^state=requested",
      fields: "sys_id,sysapproval,state,sys_updated_on,document_id",
      limit: limit * 2, // Fetch more in case some get filtered out
    })) as { result: Array<Record<string, unknown>> };

    const approvals = approvalsResult.result || [];
    const enrichedApprovals: unknown[] = [];

    // Enrich each approval with parent record details
    for (const approval of approvals) {
      const docId = approval.document_id as {
        display_value?: string;
        link?: string;
      };
      const sysapproval = approval.sysapproval as {
        value?: string;
        link?: string;
      };

      if (!sysapproval?.link) continue;

      try {
        // Extract table and sys_id from the link
        const linkMatch = sysapproval.link.match(/\/table\/([^/]+)\/([^?]+)/);
        if (!linkMatch) continue;

        const [, table, parentSysId] = linkMatch;

        // Filter by type if specified
        if (params.type && params.type !== "all" && table !== params.type) {
          continue;
        }

        // Fetch parent record details
        const parentResult = (await this.tableGet(
          table,
          parentSysId,
          "number,short_description,opened_by,opened_at,urgency,stage,state",
        )) as { result: Record<string, unknown> };

        const parent = parentResult.result || {};

        // Filter by keyword if specified
        const shortDesc = (parent.short_description as string) || "";
        if (
          params.keyword &&
          !shortDesc.toLowerCase().includes(params.keyword.toLowerCase())
        ) {
          continue;
        }

        enrichedApprovals.push({
          approval_sys_id: approval.sys_id,
          number: parent.number,
          short_description: parent.short_description,
          type: table,
          state: approval.state,
          opened_by:
            (parent.opened_by as { display_value?: string })?.display_value ||
            parent.opened_by,
          opened_at: parent.opened_at,
          urgency: parent.urgency,
          stage: parent.stage,
          waiting_since: approval.sys_updated_on,
          action: "approve",
        });

        if (enrichedApprovals.length >= limit) break;
      } catch {
        // Skip approvals we can't enrich
        continue;
      }
    }

    return enrichedApprovals;
  }
}

// ============================================================================
// MCP Server
// ============================================================================

class ServiceNowMcpServer {
  private server: Server;
  private client: ServiceNowClient;

  constructor() {
    this.server = new Server(
      { name: "servicenow", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    this.client = new ServiceNowClient();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.handleTool(
          name,
          args as Record<string, unknown>,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    });
  }

  private async handleTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // Route to appropriate handler based on tool name
    const [category, action] = name.split("_");

    switch (name) {
      // Authentication
      case "auth_browser": {
        // Use clean headless auth — clears cache to force fresh login
        clearAuthCache();
        const headers = await triggerSSOAuth();
        return {
          status: "success",
          message: "Headless authentication completed. Ready to use immediately.",
          instanceUrl: TARGET_URL,
          hasUserToken: !!headers["X-UserToken"],
        };
      }

      case "auth_status": {
        const status = this.client.getAuthStatus();
        const validation = await this.client.validateSession();
        return {
          ...status,
          sessionValid: validation.valid,
          validationError: validation.error,
        };
      }

      case "auth_import_cookies": {
        const instanceUrl = args.instance_url as string;
        const cookies = args.cookies as string;
        const userToken = args.user_token as string | undefined;

        if (!instanceUrl || !cookies) {
          throw new Error(
            "Required: instance_url and cookies. Extract these from an authenticated browser session's network request headers.",
          );
        }

        const result = importCookies(instanceUrl, cookies, userToken);
        if (result.success) {
          // Hot-reload credentials without requiring restart
          const reloaded = this.client.reloadCredentials();
          return {
            status: "success",
            message: reloaded
              ? "Cookies imported and credentials reloaded - ready to use immediately."
              : "Cookies imported and saved. Note: If this is first auth, you may need to restart Claude.",
            instanceUrl,
            hasUserToken: !!userToken,
            credentialsReloaded: reloaded,
          };
        } else {
          throw new Error(result.error || "Cookie import failed");
        }
      }

      case "auth_refresh": {
        clearAuthCache();
        const refreshHeaders = await getAuthHeaders();
        return {
          status: "success",
          message: "Session refreshed. Credentials reloaded - ready to use immediately.",
          instanceUrl: TARGET_URL,
          hasUserToken: !!refreshHeaders["X-UserToken"],
        };
      }

      // Unified Work Queue
      case "my_context":
        return this.client.getMyContext();

      case "my_work_queue":
        return this.client.getMyWorkQueue({
          include: args.include as string[],
          keyword: args.keyword as string,
          limit: args.limit as number,
        });

      // Incidents
      case "incidents_list":
        return this.client.tableQuery("incident", {
          query: args.query as string,
          fields:
            (args.fields as string) ||
            "number,short_description,state,priority,assigned_to,sys_updated_on",
          limit: (args.limit as number) || 20,
          offset: (args.offset as number) || 0,
        });

      case "incidents_get": {
        const id = await this.client.resolveId("incident", args.id as string);
        return this.client.tableGet("incident", id, args.fields as string);
      }

      case "incidents_create":
        return this.client.tableCreate(
          "incident",
          args as Record<string, unknown>,
        );

      case "incidents_update": {
        const id = await this.client.resolveId("incident", args.id as string);
        return this.client.tableUpdate(
          "incident",
          id,
          args.data as Record<string, unknown>,
        );
      }

      case "incidents_add_comment": {
        const id = await this.client.resolveId("incident", args.id as string);
        const field = args.type === "comments" ? "comments" : "work_notes";
        return this.client.tableUpdate("incident", id, {
          [field]: args.comment,
        });
      }

      case "incidents_resolve": {
        const id = await this.client.resolveId("incident", args.id as string);
        return this.client.tableUpdate("incident", id, {
          state: 6, // Resolved
          close_code: args.resolution_code,
          close_notes: args.resolution_notes,
        });
      }

      // Changes
      case "changes_list":
        return this.client.tableQuery("change_request", {
          query: args.query as string,
          fields:
            "number,short_description,state,type,start_date,end_date,assigned_to",
          limit: (args.limit as number) || 20,
        });

      case "changes_get": {
        const id = await this.client.resolveId(
          "change_request",
          args.id as string,
        );
        return this.client.tableGet("change_request", id);
      }

      case "changes_create":
        return this.client.tableCreate(
          "change_request",
          args as Record<string, unknown>,
        );

      case "changes_tasks": {
        const id = await this.client.resolveId(
          "change_request",
          args.id as string,
        );
        return this.client.tableQuery("change_task", {
          query: `change_request=${id}`,
          fields: "number,short_description,state,assigned_to,order",
        });
      }

      // Service Catalog
      case "catalog_items":
        return this.client.tableQuery("sc_cat_item", {
          query: args.query
            ? `nameLIKE${args.query}`
            : args.category
              ? `category=${args.category}`
              : "active=true",
          fields: "name,short_description,category,price,sys_id",
          limit: (args.limit as number) || 20,
        });

      case "catalog_get":
        return this.client.tableGet("sc_cat_item", args.id as string);

      case "catalog_order":
        // Use the Service Catalog API for ordering
        return this.client.tableCreate("sc_request", {
          requested_for: args.requested_for,
          // Note: Full catalog ordering requires the SC API, not table API
        });

      case "requests_list":
        return this.client.tableQuery("sc_request", {
          query: args.my_requests
            ? "requested_forDYNAMIC90d1921e5f510100a9ad2572f2b477fe"
            : (args.query as string),
          fields:
            "number,short_description,request_state,opened_at,requested_for",
          limit: (args.limit as number) || 20,
        });

      case "requests_items":
        return this.client.tableQuery("sc_req_item", {
          query: args.query as string,
          fields: "number,short_description,stage,state,request,cat_item",
          limit: (args.limit as number) || 20,
        });

      // CMDB
      case "cmdb_search":
        return this.client.tableQuery((args.class as string) || "cmdb_ci", {
          query: `nameLIKE${args.query}^ORasset_tagLIKE${args.query}`,
          fields:
            "name,sys_class_name,operational_status,install_status,location",
          limit: (args.limit as number) || 20,
        });

      case "cmdb_get":
        return this.client.tableGet(
          (args.class as string) || "cmdb_ci",
          args.id as string,
        );

      case "cmdb_relationships":
        return this.client.tableQuery("cmdb_rel_ci", {
          query: `parent=${args.id}^ORchild=${args.id}`,
          fields: "parent,child,type",
        });

      // Problems
      case "problems_list":
        return this.client.tableQuery("problem", {
          query: args.query as string,
          fields: "number,short_description,state,priority,assigned_to",
          limit: (args.limit as number) || 20,
        });

      case "problems_get": {
        const id = await this.client.resolveId("problem", args.id as string);
        return this.client.tableGet("problem", id);
      }

      case "problems_create":
        return this.client.tableCreate(
          "problem",
          args as Record<string, unknown>,
        );

      // Knowledge
      case "knowledge_search":
        return this.client.tableQuery("kb_knowledge", {
          query: `textLIKE${args.query}^workflow_state=published`,
          fields: "number,short_description,text,sys_view_count",
          limit: (args.limit as number) || 10,
        });

      case "knowledge_get": {
        const id = await this.client.resolveId(
          "kb_knowledge",
          args.id as string,
        );
        return this.client.tableGet("kb_knowledge", id);
      }

      // Users & Groups
      case "users_search":
        return this.client.tableQuery("sys_user", {
          query: `nameLIKE${args.query}^ORuser_nameLIKE${args.query}^ORemailLIKE${args.query}`,
          fields: "user_name,name,email,department,title,manager,active",
          limit: (args.limit as number) || 10,
        });

      case "users_get":
        return this.client.tableGet("sys_user", args.id as string);

      case "groups_list":
        return this.client.tableQuery("sys_user_group", {
          query: args.query ? `nameLIKE${args.query}` : "",
          fields: "name,description,manager,type,active",
          limit: (args.limit as number) || 20,
        });

      case "groups_members": {
        // First resolve group if needed
        let groupId = args.id as string;
        if (!/^[a-f0-9]{32}$/.test(groupId)) {
          const groups = (await this.client.tableQuery("sys_user_group", {
            query: `name=${groupId}`,
            fields: "sys_id",
            limit: 1,
          })) as { result: Array<{ sys_id: string }> };
          if (groups.result?.length) groupId = groups.result[0].sys_id;
        }
        return this.client.tableQuery("sys_user_grmember", {
          query: `group=${groupId}`,
          fields: "user,group",
        });
      }

      // Tasks & Approvals
      case "tasks_my_tasks":
        return this.client.tableQuery("task", {
          query:
            "assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe^active=true",
          fields: "number,short_description,state,priority,sys_class_name",
          limit: (args.limit as number) || 20,
        });

      case "tasks_update": {
        const id = await this.client.resolveId("task", args.id as string);
        return this.client.tableUpdate(
          "task",
          id,
          args.data as Record<string, unknown>,
        );
      }

      case "approvals_pending":
        return this.client.getEnrichedApprovals({
          keyword: args.keyword as string,
          type: args.type as string,
          limit: (args.limit as number) || 20,
        });

      case "approvals_approve":
        return this.client.tableUpdate(
          "sysapproval_approver",
          args.id as string,
          {
            state: "approved",
            comments: args.comments,
          },
        );

      case "approvals_reject":
        return this.client.tableUpdate(
          "sysapproval_approver",
          args.id as string,
          {
            state: "rejected",
            comments: args.comments,
          },
        );

      // Generic table operations
      case "table_query":
        return this.client.tableQuery(args.table as string, {
          query: args.query as string,
          fields: args.fields as string,
          limit: (args.limit as number) || 20,
          offset: (args.offset as number) || 0,
          orderBy: args.order_by as string,
          orderDir: args.order_dir as string,
        });

      case "table_get":
        return this.client.tableGet(
          args.table as string,
          args.id as string,
          args.fields as string,
        );

      case "table_create":
        return this.client.tableCreate(
          args.table as string,
          args.data as Record<string, unknown>,
        );

      case "table_update":
        return this.client.tableUpdate(
          args.table as string,
          args.id as string,
          args.data as Record<string, unknown>,
        );

      case "aggregate":
        return this.client.aggregate(args.table as string, {
          query: args.query as string,
          groupBy: args.group_by as string,
          aggregate: args.aggregate as string,
        });

      // Attachments (Full API)
      case "attachment_list":
        return this.client.tableQuery("sys_attachment", {
          query: `table_name=${args.table}^table_sys_id=${args.id}`,
          fields: "file_name,size_bytes,content_type,sys_created_on,sys_id",
        });

      case "attachment_get":
        return this.client.attachmentGet(args.id as string);

      case "attachment_download":
        return this.client.attachmentDownload(args.id as string);

      case "attachment_upload":
        return this.client.attachmentUpload(
          args.table as string,
          args.id as string,
          args.filename as string,
          args.content as string,
          (args.content_type as string) || "application/octet-stream",
        );

      case "attachment_delete":
        return this.client.attachmentDelete(args.id as string);

      // Service Catalog (Full sn_sc API)
      case "catalog_categories":
        return this.client.tableQuery("sc_category", {
          query: args.catalog_id
            ? `sc_catalog=${args.catalog_id}`
            : "active=true",
          fields: "title,description,sc_catalog,parent,sys_id",
          limit: (args.limit as number) || 50,
        });

      case "catalog_item_variables":
        return this.client.catalogGetVariables(args.id as string);

      case "catalog_add_to_cart":
        return this.client.catalogAddToCart(
          args.item_id as string,
          (args.quantity as number) || 1,
          (args.variables as Record<string, unknown>) || {},
        );

      case "catalog_get_cart":
        return this.client.catalogGetCart();

      case "catalog_submit_cart":
        return this.client.catalogSubmitCart();

      case "catalog_order_now":
        return this.client.catalogOrderNow(
          args.item_id as string,
          (args.quantity as number) || 1,
          (args.variables as Record<string, unknown>) || {},
          args.requested_for as string,
        );

      // IT Service Portal (ITSP) Helpers
      case "itsp_parse_url":
        return this.client.parseItspUrl(args.url as string);

      case "itsp_get_item_details":
        return this.client.itspGetItemDetails(args.url as string);

      case "itsp_submit_request":
        return this.client.itspSubmitRequest(
          args.url as string,
          (args.variables as Record<string, unknown>) || {},
          args.requested_for as string,
          args.quantity as number,
        );

      case "requests_get_details":
        return this.client.requestsGetDetails(args.number as string);

      case "requests_get_my_recent":
        return this.client.requestsGetMyRecent((args.limit as number) || 10);

      // Record Producer & Order Guide
      case "record_producer_submit":
        return this.client.recordProducerSubmit(
          args.producer_id as string,
          (args.variables as Record<string, unknown>) || {},
        );

      case "record_producer_get_details":
        return this.client.recordProducerGetDetails(args.producer_id as string);

      case "order_guide_submit":
        return this.client.orderGuideSubmit(
          args.guide_id as string,
          args.items as Array<{
            item_id: string;
            variables: Record<string, unknown>;
            quantity?: number;
          }>,
          args.requested_for as string,
        );

      case "order_guide_get_details":
        return this.client.orderGuideGetDetails(args.guide_id as string);

      case "catalog_detect_item_type":
        return this.client.catalogDetectItemType(args.item_id as string);

      // Import Set API
      case "import_set_load":
        return this.client.importSetLoad(
          args.table as string,
          args.data as Record<string, unknown>,
        );

      case "import_set_load_multiple":
        return this.client.importSetLoadMultiple(
          args.table as string,
          args.records as Array<Record<string, unknown>>,
        );

      case "import_set_status":
        return this.client.tableGet("sys_import_set", args.id as string);

      // Batch API
      case "batch_request":
        return this.client.batchRequest(
          args.requests as Array<{
            id: string;
            method: string;
            url: string;
            body?: Record<string, unknown>;
            headers?: Record<string, string>;
          }>,
        );

      // CMDB Instance API (Advanced)
      case "cmdb_classes":
        return this.client.tableQuery("sys_db_object", {
          query: `super_class.name=${args.parent_class || "cmdb_ci"}`,
          fields: "name,label,super_class",
          limit: (args.limit as number) || 50,
        });

      case "cmdb_instance_list":
        return this.client.cmdbInstanceList(
          args.class_name as string,
          args.query as string,
          args.limit as number,
        );

      case "cmdb_create":
        return this.client.tableCreate(
          args.class_name as string,
          args.data as Record<string, unknown>,
        );

      case "cmdb_update":
        return this.client.tableUpdate(
          (args.class_name as string) || "cmdb_ci",
          args.id as string,
          args.data as Record<string, unknown>,
        );

      case "cmdb_relationship_create":
        return this.client.tableCreate("cmdb_rel_ci", {
          parent: args.parent,
          child: args.child,
          type: args.type,
        });

      // Task SLA
      case "sla_list":
        return this.client.tableQuery("contract_sla", {
          query: args.query as string,
          fields: "name,type,table,duration,sys_id",
          limit: (args.limit as number) || 20,
        });

      case "task_sla_list":
        return this.client.tableQuery("task_sla", {
          query: args.task_id
            ? `task=${args.task_id}`
            : (args.query as string) || "",
          fields:
            "task,sla,stage,has_breached,planned_end_time,end_time,percentage",
          limit: (args.limit as number) || 20,
        });

      case "task_sla_get":
        return this.client.tableGet("task_sla", args.id as string);

      // Workflow
      case "workflow_list":
        return this.client.tableQuery("wf_workflow", {
          query: args.active !== false ? "active=true" : (args.query as string),
          fields: "name,table,description,active,sys_id",
          limit: (args.limit as number) || 20,
        });

      case "workflow_context_list": {
        let query = args.state ? `state=${args.state}` : "";
        if (args.table) query += `${query ? "^" : ""}table=${args.table}`;
        if (args.record_id) query += `${query ? "^" : ""}id=${args.record_id}`;
        return this.client.tableQuery("wf_context", {
          query,
          fields: "name,table,id,state,started,ended,workflow_version",
          limit: (args.limit as number) || 20,
        });
      }

      case "workflow_context_get":
        return this.client.tableGet("wf_context", args.id as string);

      // Email / Notifications
      case "email_list": {
        let query = args.type ? `type=${args.type}` : "";
        if (args.query) query = args.query as string;
        return this.client.tableQuery("sys_email", {
          query,
          fields:
            "subject,recipients,type,state,sys_created_on,target_table,instance",
          limit: (args.limit as number) || 20,
        });
      }

      case "email_get":
        return this.client.tableGet("sys_email", args.id as string);

      case "notification_list":
        return this.client.tableQuery("sysevent_email_action", {
          query:
            args.active !== false
              ? `active=true${args.table ? `^collection=${args.table}` : ""}`
              : (args.query as string),
          fields: "name,collection,event_name,recipient_fields,active",
          limit: (args.limit as number) || 20,
        });

      // Events
      case "event_list":
        return this.client.tableQuery("sysevent", {
          query: args.name ? `name=${args.name}` : (args.query as string) || "",
          fields: "name,parm1,parm2,table,sys_created_on,state",
          limit: (args.limit as number) || 20,
        });

      case "event_create":
        return this.client.tableCreate("sysevent", {
          name: args.name,
          parm1: args.instance,
          parm2: args.parm2,
          table: args.table,
        });

      // Journal / Activity Stream
      case "journal_list": {
        const journalTable = `sys_journal_field`;
        let query = `element_id=${args.id}^name=${args.table}`;
        if (args.type && args.type !== "all") {
          query += `^element=${args.type}`;
        }
        return this.client.tableQuery(journalTable, {
          query,
          fields: "element,value,sys_created_on,sys_created_by",
          limit: (args.limit as number) || 50,
        });
      }

      case "activity_stream":
        return this.client.tableQuery("sys_history_line", {
          query: `set.id=${args.id}`,
          fields: "field,old,new,label,update_time,user",
          limit: (args.limit as number) || 50,
        });

      // Audit / History
      case "audit_list":
        return this.client.tableQuery("sys_audit", {
          query: `documentkey=${args.id}^tablename=${args.table}`,
          fields: "fieldname,oldvalue,newvalue,sys_created_on,user",
          limit: (args.limit as number) || 50,
        });

      // Scheduled Jobs
      case "scheduled_job_list":
        return this.client.tableQuery("sysauto", {
          query: args.active !== false ? "active=true" : (args.query as string),
          fields: "name,run_type,run_dayofweek,run_time,active,sys_class_name",
          limit: (args.limit as number) || 20,
        });

      case "scheduled_job_run":
        // Trigger a scheduled job by updating its run field
        return this.client.tableUpdate("sysauto", args.id as string, {
          run_as_scheduled: true,
        });

      // Metrics / Performance Analytics
      case "metric_list":
        return this.client.tableQuery("pa_indicators", {
          query: args.query as string,
          fields: "name,description,unit,aggregate,frequency",
          limit: (args.limit as number) || 20,
        });

      case "metric_data": {
        let query = `indicator=${args.metric_id}`;
        if (args.start_date) query += `^sys_created_on>=${args.start_date}`;
        if (args.end_date) query += `^sys_created_on<=${args.end_date}`;
        return this.client.tableQuery("pa_scores", {
          query,
          fields: "indicator,value,date,breakdown,breakdown_value",
          limit: 100,
        });
      }

      // Update Sets
      case "update_set_list":
        return this.client.tableQuery("sys_update_set", {
          query: args.state
            ? `state=${args.state}`
            : (args.query as string) || "",
          fields: "name,state,application,description,sys_created_on",
          limit: (args.limit as number) || 20,
        });

      case "update_set_get":
        return this.client.tableGet("sys_update_set", args.id as string);

      // Security / ACL
      case "acl_list": {
        let query = "";
        if (args.table) query += `name STARTSWITH ${args.table}`;
        if (args.operation)
          query += `${query ? "^" : ""}operation=${args.operation}`;
        return this.client.tableQuery("sys_security_acl", {
          query,
          fields: "name,operation,type,condition,script,active",
          limit: (args.limit as number) || 20,
        });
      }

      case "role_list":
        return this.client.tableQuery("sys_user_role", {
          query: args.query as string,
          fields: "name,description,grantable,assignable_by",
          limit: (args.limit as number) || 50,
        });

      case "user_roles":
        return this.client.tableQuery("sys_user_has_role", {
          query: `user=${args.user_id}`,
          fields: "role,granted_by,inherited",
        });

      // Asset Management (ITAM)
      case "asset_list": {
        let query = (args.query as string) || "";
        if (args.asset_tag) query = `asset_tag=${args.asset_tag}`;
        if (args.state)
          query += `${query ? "^" : ""}install_status=${args.state}`;
        return this.client.tableQuery("alm_asset", {
          query,
          fields:
            "asset_tag,display_name,model,serial_number,install_status,assigned_to,cost",
          limit: (args.limit as number) || 20,
        });
      }

      case "asset_get": {
        const id = args.id as string;
        // Try by sys_id first, then by asset_tag
        if (/^[a-f0-9]{32}$/.test(id)) {
          return this.client.tableGet("alm_asset", id);
        }
        return this.client.tableQuery("alm_asset", {
          query: `asset_tag=${id}`,
          limit: 1,
        });
      }

      case "asset_create":
        return this.client.tableCreate(
          "alm_asset",
          args as Record<string, unknown>,
        );

      case "asset_update":
        return this.client.tableUpdate(
          "alm_asset",
          args.id as string,
          args.data as Record<string, unknown>,
        );

      // Software License Management
      case "license_list":
        return this.client.tableQuery("alm_license", {
          query: args.product
            ? `software_product.nameLIKE${args.product}`
            : (args.query as string) || "",
          fields:
            "software_product,start_date,end_date,quantity,license_type,cost",
          limit: (args.limit as number) || 20,
        });

      case "license_get":
        return this.client.tableGet("alm_license", args.id as string);

      case "license_entitlements":
        return this.client.tableQuery("alm_entitlement", {
          query: args.license_id ? `license=${args.license_id}` : "",
          fields: "license,user,allocated,start_date,end_date",
          limit: (args.limit as number) || 50,
        });

      // Software Asset Management
      case "software_list":
        return this.client.tableQuery("cmdb_sam_sw_install", {
          query: args.publisher
            ? `publisherLIKE${args.publisher}`
            : (args.query as string) || "",
          fields: "display_name,publisher,version,installed_on,install_date",
          limit: (args.limit as number) || 20,
        });

      case "software_product_list":
        return this.client.tableQuery("cmdb_software_product_model", {
          query: args.vendor
            ? `manufacturerLIKE${args.vendor}`
            : (args.query as string) || "",
          fields: "name,manufacturer,version,category",
          limit: (args.limit as number) || 20,
        });

      // Contracts
      case "contract_list":
        return this.client.tableQuery("ast_contract", {
          query: args.state
            ? `state=${args.state}`
            : (args.query as string) || "",
          fields:
            "number,short_description,vendor,start_date,end_date,state,contract_value",
          limit: (args.limit as number) || 20,
        });

      case "contract_get":
        return this.client.tableGet("ast_contract", args.id as string);

      // Location
      case "location_list":
        return this.client.tableQuery("cmn_location", {
          query: (args.query as string) || "",
          fields:
            "name,street,city,state,country,zip,latitude,longitude,parent",
          limit: (args.limit as number) || 50,
        });

      case "location_get": {
        const id = args.id as string;
        if (/^[a-f0-9]{32}$/.test(id)) {
          return this.client.tableGet("cmn_location", id);
        }
        return this.client.tableQuery("cmn_location", {
          query: `name=${id}`,
          limit: 1,
        });
      }

      // Department / Cost Center
      case "department_list":
        return this.client.tableQuery("cmn_department", {
          query: (args.query as string) || "",
          fields: "name,head,cost_center,description,parent",
          limit: (args.limit as number) || 50,
        });

      case "cost_center_list":
        return this.client.tableQuery("cmn_cost_center", {
          query: (args.query as string) || "",
          fields: "name,account_number,manager,valid_from,valid_to",
          limit: (args.limit as number) || 50,
        });

      // Discovery / ITOM
      case "discovery_status_list":
        return this.client.tableQuery("discovery_status", {
          query: args.state
            ? `state=${args.state}`
            : (args.query as string) || "",
          fields: "name,state,type,schedule,started,completed,scanned_devices",
          limit: (args.limit as number) || 20,
        });

      case "discovery_schedule_list":
        return this.client.tableQuery("discovery_schedule", {
          query:
            args.active !== false
              ? "active=true"
              : (args.query as string) || "",
          fields: "name,discover,run_type,run_time,max_run_time,active",
          limit: (args.limit as number) || 20,
        });

      // Table delete
      case "table_delete":
        return this.client.tableDelete(args.table as string, args.id as string);

      // Table schema
      case "table_schema":
        return this.client.tableQuery("sys_dictionary", {
          query: `name=${args.table}`,
          fields:
            "element,column_label,internal_type,max_length,mandatory,reference",
          limit: 200,
        });

      // Choice list
      case "choice_list":
        return this.client.tableQuery("sys_choice", {
          query: `name=${args.table}^element=${args.field}`,
          fields: "value,label,sequence,inactive",
        });

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("ServiceNow MCP server running on stdio");
  }
}

// Auto-setup check: ensure configuration exists before starting server
async function main() {
  const setupSuccess = await autoSetup();
  if (!setupSuccess) {
    console.error("❌ ServiceNow MCP cannot start without valid configuration");
    process.exit(1);
  }

  const server = new ServiceNowMcpServer();
  await server.run();
}

main().catch((error) => {
  console.error("❌ ServiceNow MCP server error:", error);
  process.exit(1);
});
