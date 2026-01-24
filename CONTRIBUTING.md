# Contributing to ServiceNow MCP Server

Thank you for your interest in contributing! This document provides guidelines for contributing to this project.

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what is best for the community

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/yourusername/servicenow-mcp/issues)
2. If not, create a new issue with:
   - Clear, descriptive title
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (Node version, OS, etc.)

### Suggesting Features

1. Check [Discussions](https://github.com/yourusername/servicenow-mcp/discussions) for similar ideas
2. Create a new discussion or issue describing:
   - The problem you're trying to solve
   - Your proposed solution
   - Why this would be useful to others

### Pull Requests

1. **Fork** the repository
2. **Create a branch** for your feature:
   ```bash
   git checkout -b feature/amazing-feature
   ```
3. **Make your changes**:
   - Write clear, concise commit messages
   - Follow the existing code style
   - Add tests if applicable
   - Update documentation as needed
4. **Test your changes**:
   ```bash
   npm run build
   npm test
   ```
5. **Commit** your changes:
   ```bash
   git commit -m "Add amazing feature"
   ```
6. **Push** to your fork:
   ```bash
   git push origin feature/amazing-feature
   ```
7. **Open a Pull Request** with:
   - Clear description of changes
   - Reference to related issues
   - Screenshots (if UI changes)

## Development Setup

```bash
# Clone your fork
git clone https://github.com/yourusername/servicenow-mcp.git
cd servicenow-mcp

# Install dependencies
npm install

# Build the project
npm run build

# Run in development mode
npm run dev
```

## Code Style

- Use TypeScript strict mode
- Follow existing naming conventions
- Add JSDoc comments for public APIs
- Keep functions focused and small
- Use async/await over promises

## Testing

When adding new tools:

1. Add integration tests
2. Test with real ServiceNow instance (if possible)
3. Verify error handling
4. Check authentication flows

## Documentation

- Update README.md for new features
- Add JSDoc comments to new functions
- Include examples in tool descriptions
- Update .env.example if adding new config

## Questions?

Feel free to:

- Open a [Discussion](https://github.com/yourusername/servicenow-mcp/discussions)
- Ask in your pull request
- Reach out to maintainers

Thank you for contributing! 🎉
