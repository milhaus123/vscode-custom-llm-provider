import * as vscode from 'vscode';

/**
 * API keys live in VS Code's encrypted SecretStorage (OS keychain), never in
 * settings.json. Keys are addressed by the provider slug (`ProviderConfig.id`),
 * which is stable across renames and endpoint changes.
 */
const SECRET_PREFIX = 'customLlm.apiKey.';

export class ApiKeyStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private secretKey(providerId: string): string {
    return `${SECRET_PREFIX}${providerId}`;
  }

  /** Returns the stored key, or '' when the provider has none. */
  async get(providerId: string): Promise<string> {
    if (!providerId) { return ''; }
    try {
      return (await this.secrets.get(this.secretKey(providerId))) ?? '';
    } catch (e) {
      // Keychain unavailable (e.g. headless Linux without a secret service)
      console.error(`Custom LLM: could not read API key for "${providerId}":`, e);
      return '';
    }
  }

  /** Stores a key; an empty value removes it. */
  async set(providerId: string, apiKey: string): Promise<void> {
    if (!providerId) { return; }
    if (!apiKey) {
      await this.delete(providerId);
      return;
    }
    await this.secrets.store(this.secretKey(providerId), apiKey);
  }

  async delete(providerId: string): Promise<void> {
    if (!providerId) { return; }
    try {
      await this.secrets.delete(this.secretKey(providerId));
    } catch { /* nothing stored / keychain unavailable */ }
  }

  async has(providerId: string): Promise<boolean> {
    return (await this.get(providerId)).length > 0;
  }

  /** Convenience: resolve keys for many providers in one go. */
  async getMany(providerIds: readonly string[]): Promise<Map<string, string>> {
    const entries = await Promise.all(
      providerIds.map(async id => [id, await this.get(id)] as const)
    );
    return new Map(entries);
  }
}
