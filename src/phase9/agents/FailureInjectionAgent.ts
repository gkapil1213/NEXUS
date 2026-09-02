import { ChaosFixture } from '../fixture/chaosService';

export type FailureType = 'HTTP_503' | 'HTTP_DELAY' | 'CONNECTION_REFUSED';

export interface InjectionResult {
  failure_type: FailureType;
  started_at: string;
  ended_at: string;
  duration_ms: number;
}

export class FailureInjectionAgent {
  constructor(private fixture: ChaosFixture) {}

  async inject(failureType: FailureType, durationMs: number): Promise<InjectionResult> {
    const start = Date.now();
    let mode: 'normal' | 'delay' | 'error' = 'normal';
    switch (failureType) {
      case 'HTTP_503': mode = 'error'; break;
      case 'HTTP_DELAY': mode = 'delay'; break;
      case 'CONNECTION_REFUSED': mode = 'error'; break;
    }

    await fetch(`http://localhost:${this.fixture.port}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });

    await new Promise(resolve => setTimeout(resolve, durationMs));

    await fetch(`http://localhost:${this.fixture.port}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'normal' })
    });

    const end = Date.now();
    return {
      failure_type: failureType,
      started_at: new Date(start).toISOString(),
      ended_at: new Date(end).toISOString(),
      duration_ms: end - start
    };
  }
}
