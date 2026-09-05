export interface SchemaState {
  resourceId: string;
  currentFingerprint: string;
  expectedFingerprint: string;
  migrationVersion: number;
  pendingMigrations: string[];
  appliedMigrations: string[];
  failedMigrations: string[];
  rollbackAvailable: boolean;
  updatedAt: string;
}

export function createSchemaState(input: Omit<SchemaState, 'updatedAt'>): SchemaState {
  return { ...input, updatedAt: new Date().toISOString() };
}
