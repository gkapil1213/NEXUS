import { useCallback, useRef, useState } from "react";
import { emptySnapshot, runPipeline, type RunSnapshot } from "./core/engine";
import { buildWorkspace, type Scenario } from "./core/sample";

export function usePipeline() {
  const [snap, setSnap] = useState<RunSnapshot>(emptySnapshot());
  const [running, setRunning] = useState(false);
  const runToken = useRef(0);

  const run = useCallback(async (scenario: Scenario, prompt: string) => {
    const token = ++runToken.current;
    setRunning(true);
    setSnap(emptySnapshot());
    const workspace = buildWorkspace(scenario);
    const final = await runPipeline(workspace, prompt, {
      onUpdate: (s) => {
        if (runToken.current === token) setSnap(s);
      },
    });
    if (runToken.current === token) {
      setSnap(final);
      setRunning(false);
    }
  }, []);

  const reset = useCallback(() => {
    runToken.current += 1;
    setRunning(false);
    setSnap(emptySnapshot());
  }, []);

  return { snap, running, run, reset };
}
