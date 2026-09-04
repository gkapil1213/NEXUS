import { ExecutionAdapter } from "./execution-adapter";

export class ExecutionAdapterRegistry {
  private adapters = new Map<string, ExecutionAdapter>();
  private disabled = new Set<string>();

  register(adapter: ExecutionAdapter): void {
    const id = adapter.getId();
    if (this.adapters.has(id)) {
      throw new Error(`Adapter ${id} already registered`);
    }
    this.adapters.set(id, adapter);
  }

  unregister(id: string): void {
    this.adapters.delete(id);
    this.disabled.delete(id);
  }

  disable(id: string): void {
    if (!this.adapters.has(id)) throw new Error(`Adapter ${id} not found`);
    this.disabled.add(id);
  }

  enable(id: string): void {
    this.disabled.delete(id);
  }

  get(id: string): ExecutionAdapter | undefined {
    if (this.disabled.has(id)) return undefined;
    return this.adapters.get(id);
  }

  list(): ExecutionAdapter[] {
    return Array.from(this.adapters.values()).filter((a) => !this.disabled.has(a.getId()));
  }

  has(id: string): boolean {
    return this.adapters.has(id) && !this.disabled.has(id);
  }

  validateCapabilities(id: string, required: string[]): boolean {
    const adapter = this.get(id);
    if (!adapter) return false;
    const caps = new Set(adapter.getCapabilities());
    return required.every((c) => caps.has(c));
  }
}
