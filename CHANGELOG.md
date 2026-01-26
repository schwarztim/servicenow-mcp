# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
