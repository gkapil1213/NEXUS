import { CICDProvider } from "./cicd-provider";

export class CICDProviderRegistry {
  private providers = new Map<string, CICDProvider>();
  private disabled = new Set<string>();

  register(provider: CICDProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider ${provider.id} already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id);
    this.disabled.delete(id);
  }

  disable(id: string): void {
    if (!this.providers.has(id)) throw new Error(`Provider ${id} not found`);
    this.disabled.add(id);
  }

  enable(id: string): void {
    this.disabled.delete(id);
  }

  get(id: string): CICDProvider | undefined {
    if (this.disabled.has(id)) return undefined;
    return this.providers.get(id);
  }

  list(): CICDProvider[] {
    return Array.from(this.providers.values()).filter((p) => !this.disabled.has(p.id));
  }
}
