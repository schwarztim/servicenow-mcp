import keytar from "keytar";

const SERVICE_NAME = "servicenow-mcp";

export class CredentialStore {
  /**
   * Store password in system keychain
   */
  async setPassword(email: string, password: string): Promise<void> {
    await keytar.setPassword(SERVICE_NAME, email, password);
  }

  /**
   * Retrieve password from system keychain
   */
  async getPassword(email: string): Promise<string | null> {
    return await keytar.getPassword(SERVICE_NAME, email);
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
