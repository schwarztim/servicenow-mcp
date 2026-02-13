import keytar from "keytar";

const SERVICE_NAME = "servicenow-mcp";
const CORP_SSO_SERVICE = "corp-sso";

export class CredentialStore {
  /**
   * Store password in system keychain
   */
  async setPassword(email: string, password: string): Promise<void> {
    await keytar.setPassword(SERVICE_NAME, email, password);
  }

  /**
   * Retrieve password from system keychain
   * Checks corp-sso keychain entries first, then falls back to servicenow-mcp
   */
  async getPassword(email: string): Promise<string | null> {
    // Try corp-sso keychain first (preferred)
    try {
      const corpPassword = await keytar.getPassword(CORP_SSO_SERVICE, "password");
      if (corpPassword) {
        return corpPassword;
      }
    } catch { /* fall through */ }

    // Fallback to servicenow-mcp keychain
    return await keytar.getPassword(SERVICE_NAME, email);
  }

  /**
   * Retrieve email from corp-sso keychain, or return the provided email
   */
  async getEmail(fallbackEmail?: string): Promise<string | null> {
    try {
      const corpEmail = await keytar.getPassword(CORP_SSO_SERVICE, "email");
      if (corpEmail) {
        return corpEmail;
      }
    } catch { /* fall through */ }
    return fallbackEmail || null;
  }

  /**
   * Delete password from system keychain
   */
  async deletePassword(email: string): Promise<boolean> {
    return await keytar.deletePassword(SERVICE_NAME, email);
  }

  /**
   * Check if password exists for email
   */
  async hasPassword(email: string): Promise<boolean> {
    const password = await this.getPassword(email);
    return password !== null;
  }
}
