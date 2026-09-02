export class RecoveryAgent {
  async verifyRecovery(url: string): Promise<boolean> {
    try {
      const res = await fetch(url);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async waitForRecovery(url: string, timeoutMs: number = 10000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.verifyRecovery(url)) return true;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }
}
