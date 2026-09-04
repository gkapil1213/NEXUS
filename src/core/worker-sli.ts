export class WorkerSli {
  evaluate(values: number[]): { value: number; sufficient: boolean } {
    if (!values || values.length === 0) return { value: 0, sufficient: false };
    const valid = values.filter(v => Number.isFinite(v));
    if (valid.length === 0) return { value: 0, sufficient: false };
    return {
      value: valid.reduce((a, b) => a + b, 0) / valid.length,
      sufficient: valid.length >= 3,
    };
  }
}
