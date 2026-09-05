export type ChangeCategory = 'APPLICATION' | 'UI' | 'DATABASE' | 'MIGRATION' | 'INFRASTRUCTURE' | 'SECURITY' | 'DEPENDENCY' | 'CONFIGURATION' | 'DOCUMENTATION' | 'UNKNOWN';

export interface ChangeInfo {
  repository: string;
  branch: string;
  commitSha: string;
  parentSha: string;
  changedFiles: string[];
  category: ChangeCategory;
  affectedComponents: string[];
  isSecuritySensitive: boolean;
}

export function classifyChange(files: string[]): ChangeCategory {
  if (files.some(f => f.includes('migration') || f.endsWith('.sql'))) return 'MIGRATION';
  if (files.some(f => f.includes('package.json') || f.includes('package-lock.json'))) return 'DEPENDENCY';
  if (files.some(f => f.includes('security') || f.includes('auth'))) return 'SECURITY';
  if (files.some(f => f.includes('infra') || f.includes('docker') || f.includes('k8s'))) return 'INFRASTRUCTURE';
  if (files.some(f => f.includes('ui') || f.includes('component') || f.endsWith('.css'))) return 'UI';
  if (files.some(f => f.includes('config') || f.endsWith('.env'))) return 'CONFIGURATION';
  if (files.some(f => f.endsWith('.md'))) return 'DOCUMENTATION';
  if (files.some(f => f.includes('src') || f.endsWith('.ts') || f.endsWith('.js'))) return 'APPLICATION';
  return 'UNKNOWN';
}
