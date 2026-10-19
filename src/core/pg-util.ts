// src/core/pg-util.ts
// Shared connection-lifecycle helper. Wraps PgClient in a scoped
// open/close so executors never leak connections and never duplicate
// the try/finally boilerplate. Mirrors EngineeringDiagnosisExecutor.withPg.
import { PgClient } from "./pg-client";

export async function withPg<T>(
  dbUrl: string,
  fn: (pg: PgClient) => Promise<T>,
): Promise<T> {
  const pg = new PgClient();
  await pg.connect(dbUrl);
  try {
    return await fn(pg);
  } finally {
    await pg.close();
  }
}
