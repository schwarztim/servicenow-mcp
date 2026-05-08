import { VaultStore } from "node-vault-mcp";

const SERVICE_NAME = "servicenow-mcp";
const CORP_SSO_SERVICE = "corp-sso";
const store = new VaultStore();

export class CredentialStore {
  /**
   * Store password in the shared vault
   */
  async setPassword(email: string, password: string): Promise<void> {
    await store.setPassword(SERVICE_NAME, email, password);
  }

  /**
   * Retrieve password from the shared vault.
   * Checks corp-sso entries first, then falls back to servicenow-mcp.
   */
  async getPassword(email: string): Promise<string | null> {
    try {
      const corpPassword = await store.getPassword(CORP_SSO_SERVICE, "password");
      if (corpPassword) {
        return corpPassword;
      }
    } catch {
      /* fall through */
    }

    return await store.getPassword(SERVICE_NAME, email);
  }

  /**
   * Retrieve email from corp-sso entries, or return the provided email
   */
  async getEmail(fallbackEmail?: string): Promise<string | null> {
    try {
      const corpEmail = await store.getPassword(CORP_SSO_SERVICE, "email");
      if (corpEmail) {
        return corpEmail;
      }
    } catch {
      /* fall through */
    }
    return fallbackEmail || null;
  }

  /**
   * Delete password from the shared vault
   */
  async deletePassword(email: string): Promise<boolean> {
    return await store.deletePassword(SERVICE_NAME, email);
  }

  /**
   * Check if password exists for email
   */
  async hasPassword(email: string): Promise<boolean> {
    const password = await this.getPassword(email);
    return password !== null;
  }
}
