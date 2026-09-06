import { randomUUID } from 'crypto';

export function processLineage(input: any): any {
  return { id: randomUUID(), commit: input.commit, pipeline: input.pipeline };
}
