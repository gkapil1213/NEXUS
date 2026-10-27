import { NexusKernel } from './src/core/kernel';

async function main() {
  const k = new NexusKernel();
  await k.boot();
  console.log('BOOT OK — remote_execution_results should now exist');
  await (k as any).shutdown({ finalRecoveryPass: false }).catch(() => {});
  process.exit(0);
}
main().catch((e) => { console.error('BOOT FAILED:', (e as Error).message); process.exit(1); });
