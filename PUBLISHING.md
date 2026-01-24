# Publishing to npm

This guide explains how to publish `servicenow-mcp` to npm.

## Prerequisites

1. **npm account**: Sign up at https://www.npmjs.com/signup
2. **npm login**: Run `npm login` to authenticate
3. **2FA enabled**: Recommended for security

## Pre-publish Checklist

Before publishing, ensure:

- [ ] All tests pass: `npm test` (if tests exist)
- [ ] Build succeeds: `npm run build`
- [ ] TypeScript compiles: `npx tsc --noEmit`
- [ ] Version bumped in `package.json`
- [ ] CHANGELOG updated (if you maintain one)
- [ ] README is up to date
- [ ] All commits pushed to GitHub

## Version Bumping

Use npm's built-in version commands:

```bash
# Patch release (1.1.0 -> 1.1.1) - bug fixes
npm version patch

# Minor release (1.1.0 -> 1.2.0) - new features
npm version minor

# Major release (1.1.0 -> 2.0.0) - breaking changes
npm version major
```

This automatically:

- Updates `package.json`
- Creates a git commit
- Creates a git tag

## Publishing

### Dry Run (Recommended First Time)

See what will be published without actually publishing:

```bash
npm pack --dry-run
```

Or create an actual tarball to inspect:

```bash
npm pack
tar -tzf servicenow-mcp-*.tgz
```

### Publish to npm

```bash
# Build the project
npm run build

# Publish (prepublishOnly script runs automatically)
npm publish
```

### Publish a Beta/Pre-release

```bash
# Tag as beta
npm version 1.2.0-beta.1

# Publish with beta tag
npm publish --tag beta
```

Users install with: `npm install servicenow-mcp@beta`

## Post-publish

1. **Create GitHub Release**:

   ```bash
   gh release create v1.1.0 --generate-notes
   ```

2. **Verify npm page**: https://www.npmjs.com/package/servicenow-mcp

3. **Test installation**:
   ```bash
   npm install -g servicenow-mcp
   ```

## Unpublishing (Emergency Only)

You can only unpublish within 72 hours:

```bash
npm unpublish servicenow-mcp@1.1.0
```

**Warning**: This is permanent and discouraged. Use `npm deprecate` instead:

```bash
npm deprecate servicenow-mcp@1.1.0 "Use version 1.1.1 instead"
```

## Common Issues

### "You cannot publish over the previously published versions"

- Version already exists on npm
- Bump the version: `npm version patch`

### "You must verify your email"

- Check your npm account email
- Verify the email address

### "You do not have permission to publish"

- Check if package name is taken: https://www.npmjs.com/package/servicenow-mcp
- Login with correct account: `npm whoami`

## Automated Publishing (GitHub Actions)

To automate publishing on release:

1. Get npm token: `npm token create`
2. Add to GitHub Secrets: `NPM_TOKEN`
3. Create `.github/workflows/publish.yml`:

```yaml
name: Publish

on:
  release:
    types: [created]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20.x"
          registry-url: "https://registry.npmjs.org"
      - run: npm ci
      - run: npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Support

Questions? Open an issue: https://github.com/schwarztim/servicenow-mcp/issues
