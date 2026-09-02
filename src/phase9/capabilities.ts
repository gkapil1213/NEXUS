import { execSync } from 'child_process';

export interface Capability {
  name: string;
  available: boolean;
  version?: string;
  reason?: string;
  checked_at: string;
}

export function detectCapabilities(): Capability[] {
  const tools = [
    'node', 'npm', 'python', 'pytest', 'docker', 'curl', 'git',
    'playwright', 'chromium', 'k6', 'jmeter', 'artillery', 'autocannon', 'wrk', 'hey'
  ];

  const results: Capability[] = [];

  for (const tool of tools) {
    try {
      const version = execSync(`${tool} --version`, { encoding: 'utf8', timeout: 5000 }).trim();
      results.push({
        name: tool,
        available: true,
        version,
        reason: 'executable found',
        checked_at: new Date().toISOString()
      });
    } catch (error: any) {
      results.push({
        name: tool,
        available: false,
        reason: error.message,
        checked_at: new Date().toISOString()
      });
    }
  }

  return results;
}
