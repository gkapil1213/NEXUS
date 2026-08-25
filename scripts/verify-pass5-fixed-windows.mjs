import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const WIN = process.platform === 'win32';
const NODE = process.execPath;
const NPM = WIN ? 'npm.cmd' : 'npm';
const NPX = WIN ? 'npx.cmd' : 'npx';
const TRIVY_IMAGE = 'aquasec/trivy:0.74.0';

const tag = `nexus-pass5-${Date.now()}`;
const container = `nexus-pass5-staging-${Date.now()}`;

const evidence = {
  timestamp: new Date().toISOString(),
  platform: process.platform,
  capabilities: {},
  build: {},
  sbom: {},
  docker: {},
  image: {},
  container_security: {},
  image_sbom: {},
  staging: {},
  health: {},
  smoke: {},
  quality_gate: {},
  rollback: {},
  rollback_verification: {},
  regression: {},
  typescript_build: {},
  files_changed: []
};

function run(exe, args = [], timeout = 120000) {
  const started = Date.now();
  const resolved = WIN && exe === 'npm' ? 'npm.cmd'
    : WIN && exe === 'npx' ? 'npx.cmd'
    : WIN && exe === 'powershell' ? 'powershell.exe'
    : exe;
  const useShell = WIN && /\.(cmd|bat)$/i.test(resolved);
  const result = spawnSync(resolved, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: useShell
  });
  return {
    success: result.status === 0,
    exitCode: result.status,
    signal: result.signal || null,
    error: result.error ? String(result.error.message || result.error) : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    duration_ms: Date.now() - started,
    executable: resolved,
    args
  };
}

function setBlocked(obj, reason) {
  Object.assign(obj, { status: 'BLOCKED', reason });
  return obj;
}

/*
 * REAL TRIVY EXECUTION
 */
function trivyRun(args, timeout = 600000) {
  const native = run('trivy', args, timeout);
  if (native.success) {
    return { ...native, provider: 'native-trivy' };
  }
  if (!evidence.capabilities.trivyDocker) {
    return { ...native, provider: 'none', fallbackFromNative: false, reason: 'Native Trivy failed and Docker Trivy is unavailable.' };
  }
  const dockerArgs = [
    'run', '--rm',
    '--mount', `type=bind,source=${root.replace(/\\/g, '/')},target=/work`,
    '--mount', 'type=bind,source=//var/run/docker.sock,target=/var/run/docker.sock',
    '-w', '/work',
    TRIVY_IMAGE,
    ...args
  ];
  const dockerResult = run('docker', dockerArgs, timeout);
  return {
    ...dockerResult,
    provider: 'docker-trivy',
    fallbackFromNative: true,
    nativeError: native.error || native.stderr || null
  };
}

/*
 * CAPABILITY DETECTION
 */
function probe() {
  const nodeResult = run(NODE, ['--version'], 15000);
  const npmResult = run(NPM, ['--version'], 15000);
  const gitResult = run('git', ['--version'], 15000);
  const dockerVersion = run('docker', ['version', '--format', '{{.Client.Version}}'], 15000);
  const dockerInfo = dockerVersion.success ? run('docker', ['info'], 30000) : null;
  const trivyNative = run('trivy', ['--version'], 15000);
  const trivyDocker = dockerInfo?.success
    ? run('docker', ['run', '--rm', TRIVY_IMAGE, '--version'], 120000)
    : null;
  const playwright = run(NPX, ['playwright', '--version'], 30000);
  const smokeSpec = existsSync(join(root, 'tests', 'smoke', 'nexus-staging.spec.ts'))
    ? 'tests/smoke/nexus-staging.spec.ts' : null;

  evidence.capabilities = {
    node: nodeResult.success ? nodeResult.stdout.trim() : null,
    npm: npmResult.success ? npmResult.stdout.trim() : null,
    git: gitResult.success ? gitResult.stdout.trim() : null,
    docker: dockerVersion.success,
    docker_daemon: !!dockerInfo?.success,
    trivy: trivyNative.success || !!trivyDocker?.success,
    trivyNative: trivyNative.success,
    trivyDocker: !!trivyDocker?.success,
    playwright: playwright.success,
    chromium: null,
    smokeSpec: !!smokeSpec
  };
  evidence.capabilities_details = {
    nativeTrivy: trivyNative,
    dockerTrivy: trivyDocker,
    dockerVersion,
    dockerInfo,
    playwright
  };
}

/*
 * BUILD
 */
function build() {
  const typecheck = run(NPM, ['run', 'typecheck'], 300000);
  const buildResult = run(NPM, ['run', 'build'], 300000);
  evidence.typescript_build = { typecheck, build: buildResult };
  evidence.build = {
    status: typecheck.success && buildResult.success ? 'PASS' : 'FAIL',
    typecheck,
    build: buildResult
  };
}

/*
 * SOURCE SBOM
 */
function sbom() {
  if (!evidence.capabilities.trivy) return setBlocked(evidence.sbom, 'No usable native Trivy or Docker Trivy provider.');
  const file = join(root, `.nexus-pass5-sbom-${Date.now()}.json`);
  const outputPath = evidence.capabilities.trivyNative ? file : `/work/${file.split('\\').pop()}`;
  const args = ['fs', '--format', 'cyclonedx', '--output', outputPath, '.'];
  const result = trivyRun(args, 300000);
  if (!result.success || !existsSync(file)) {
    evidence.sbom = { status: 'FAIL', command: result };
    return;
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const components = Array.isArray(data.components) ? data.components.length : 0;
    evidence.sbom = {
      status: data.bomFormat === 'CycloneDX' && components > 0 ? 'PASS' : 'FAIL',
      file,
      format: data.bomFormat || null,
      components,
      provider: result.provider || null,
      command: result
    };
  } catch (error) {
    evidence.sbom = { status: 'FAIL', reason: error.message, command: result };
  }
}

/*
 * REAL DOCKER BUILD
 */
function dockerBuild() {
  if (!evidence.capabilities.docker_daemon) return setBlocked(evidence.docker, 'Docker daemon unavailable.');
  const result = run('docker', ['build', '-t', tag, '.'], 600000);
  if (!result.success) {
    evidence.docker = { status: 'FAIL', command: result };
    return setBlocked(evidence.image, 'Docker build failed.');
  }
  const inspect = run('docker', ['inspect', tag], 30000);
  if (!inspect.success) {
    evidence.docker = { status: 'FAIL', build: result, inspect };
    return;
  }
  let image;
  try {
    image = JSON.parse(inspect.stdout)[0];
  } catch (error) {
    evidence.docker = { status: 'FAIL', reason: `Invalid docker inspect JSON: ${error.message}`, build: result, inspect };
    return;
  }
  const digest = image.RepoDigests?.[0] || null;
  evidence.docker = { status: 'PASS', tag, imageId: image.Id, digest, build: result, inspect };
  evidence.image = {
    status: 'PASS',
    imageId: image.Id,
    repoTags: image.RepoTags || [],
    architecture: image.Architecture,
    created: image.Created,
    config: image.Config || {},
    digest
  };
}

/*
 * REAL CONTAINER SECURITY SCAN
 */
function security() {
  if (evidence.docker.status !== 'PASS') return setBlocked(evidence.container_security, 'No real image exists.');
  if (!evidence.capabilities.trivy) return setBlocked(evidence.container_security, 'Trivy unavailable.');
  const result = trivyRun(['image', '--format', 'json', tag], 600000);
  if (!result.success) {
    evidence.container_security = { status: 'FAIL', command: result };
    return;
  }
  try {
    const data = JSON.parse(result.stdout);
    const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
    for (const resultItem of data.Results || []) {
      for (const vulnerability of resultItem.Vulnerabilities || []) {
        if (counts[vulnerability.Severity] !== undefined) counts[vulnerability.Severity]++;
      }
    }
    evidence.container_security = {
      status: 'PASS',
      scanner: result.provider || 'trivy',
      image: tag,
      critical: counts.CRITICAL,
      high: counts.HIGH,
      medium: counts.MEDIUM,
      low: counts.LOW,
      unknown: counts.UNKNOWN,
      command: result
    };
  } catch (error) {
    evidence.container_security = { status: 'FAIL', reason: error.message, command: result };
  }
}

/*
 * REAL IMAGE SBOM
 */
function imageSbom() {
  if (evidence.docker.status !== 'PASS') return setBlocked(evidence.image_sbom, 'No real image exists.');
  if (!evidence.capabilities.trivy) return setBlocked(evidence.image_sbom, 'Trivy unavailable.');
  const file = join(root, `.nexus-pass5-image-${Date.now()}.json`);
  const outputPath = evidence.capabilities.trivyNative ? file : `/work/${file.split('\\').pop()}`;
  const args = ['image', '--format', 'cyclonedx', '--output', outputPath, tag];
  const result = trivyRun(args, 600000);
  if (!result.success || !existsSync(file)) {
    evidence.image_sbom = { status: 'FAIL', command: result };
    return;
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const components = Array.isArray(data.components) ? data.components.length : 0;
    evidence.image_sbom = {
      status: data.bomFormat === 'CycloneDX' && components > 0 ? 'PASS' : 'FAIL',
      image: tag,
      file,
      components,
      format: data.bomFormat || null,
      provider: result.provider || null,
      command: result
    };
  } catch (error) {
    evidence.image_sbom = { status: 'FAIL', reason: error.message, command: result };
  }
}

/*
 * REAL STAGING + HEALTH
 */
async function stagingHealth() {
  if (evidence.docker.status !== 'PASS') {
    setBlocked(evidence.staging, 'No built image.');
    setBlocked(evidence.health, 'No staging deployment.');
    return;
  }
  const inspect = run('docker', ['inspect', tag], 30000);
  if (!inspect.success) {
    evidence.staging = { status: 'FAIL', reason: 'Unable to inspect built image.', command: inspect };
    setBlocked(evidence.health, 'Image inspection failed.');
    return;
  }
  let imageInfo;
  try {
    imageInfo = JSON.parse(inspect.stdout)[0];
  } catch (error) {
    evidence.staging = { status: 'FAIL', reason: `Invalid docker inspect JSON: ${error.message}`, command: inspect };
    setBlocked(evidence.health, 'Invalid image inspection.');
    return;
  }
  const exposedPorts = Object.keys(imageInfo.Config?.ExposedPorts || {})
    .map(port => Number(String(port).split('/')[0]))
    .filter(Number.isInteger);
  const containerPort = exposedPorts[0] || 8080;

  const portProbe = run('powershell', ['-NoProfile', '-Command', "$l=8000..10000|%{$p=$_;try{$x=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$p);$x.Start();$x.Stop();$p;break}catch{}}"], 30000);
  const port = Number(portProbe.stdout.trim().split(/\s+/).filter(Boolean)[0]);
  if (!port) {
    setBlocked(evidence.staging, 'Could not allocate a host port.');
    setBlocked(evidence.health, 'Staging was not started.');
    return;
  }
  const start = run('docker', ['run', '-d', '--name', container, '-p', `${port}:${containerPort}`, tag], 120000);
  if (!start.success) {
    evidence.staging = { status: 'FAIL', containerName: container, hostPort: port, containerPort, image: tag, command: start };
    setBlocked(evidence.health, 'Staging container failed to start.');
    return;
  }
  await new Promise(resolve => setTimeout(resolve, 4000));
  const ps = run('docker', ['ps', '--filter', `name=^${container}$`, '--format', '{{.Status}}'], 30000);
  evidence.staging = {
    status: ps.success && ps.stdout.trim() ? 'PASS' : 'FAIL',
    containerName: container,
    hostPort: port,
    containerPort,
    image: tag,
    command: start,
    statusOutput: ps.stdout.trim()
  };
  if (evidence.staging.status !== 'PASS') {
    const logs = run('docker', ['logs', container], 30000);
    evidence.staging.logs = logs;
    setBlocked(evidence.health, 'Container is not running.');
    return;
  }
  const candidates = [process.env.NEXUS_HEALTH_PATH, '/health', '/healthz', '/api/health', '/'].filter(Boolean);
  for (const path of [...new Set(candidates)]) {
    const url = `http://127.0.0.1:${port}${path}`;
    const health = run('curl.exe', ['-sS', '-o', `${tmpdir()}/nexus-pass5-health.txt`, '-w', '%{http_code}', url], 20000);
    const code = Number(health.stdout.trim());
    if (health.success && code >= 200 && code < 400) {
      process.env.STAGING_URL = `http://127.0.0.1:${port}`;
      evidence.health = { status: 'PASS', url, endpoint: path, http_status: code, command: health };
      return;
    }
  }
  const logs = run('docker', ['logs', container], 30000);
  evidence.health = {
    status: 'FAIL',
    reason: 'No health endpoint returned HTTP 2xx/3xx.',
    container,
    command: logs,
    logs
  };
}

/*
 * REAL PLAYWRIGHT / CHROMIUM TEST
 */
function smoke() {
  if (evidence.staging.status !== 'PASS' || evidence.health.status !== 'PASS')
    return setBlocked(evidence.smoke, 'Real staging/health did not pass.');
  const spec = existsSync(join(root, 'tests', 'smoke', 'nexus-staging.spec.ts'))
    ? 'tests/smoke/nexus-staging.spec.ts' : null;
  if (!spec) return setBlocked(evidence.smoke, 'Existing staging smoke spec not found.');
  if (!evidence.capabilities.playwright) return setBlocked(evidence.smoke, 'Playwright CLI is unavailable.');

  const result = run(NPX, ['playwright', 'test', '--reporter=line'], 600000);
  evidence.capabilities.chromium = result.success;
  evidence.smoke = {
    status: result.success ? 'PASS' : 'FAIL',
    browser_proof: result.success ? 'Real Playwright browser execution succeeded.' : 'Real Playwright browser execution failed.',
    spec,
    staging_url: process.env.STAGING_URL || null,
    command: result
  };
}

/*
 * QUALITY GATE
 */
function gate() {
  const stages = ['build', 'sbom', 'docker', 'image', 'container_security', 'image_sbom', 'staging', 'health', 'smoke'];
  const statuses = stages.map(stage => evidence[stage].status);
  evidence.quality_gate = {
    status: statuses.includes('BLOCKED') ? 'BLOCKED' : statuses.includes('FAIL') ? 'FAIL' : 'PASS',
    checks: Object.fromEntries(stages.map(stage => [stage, evidence[stage].status]))
  };
}

/*
 * REAL ROLLBACK VERIFICATION
 * - Deploy good version, verify health.
 * - Stop good, deploy bad (same image, failing command), confirm failure.
 * - Rollback: remove bad, redeploy good, verify health again.
 */
function rollback() {
  // Check prerequisites
  if (evidence.docker.status !== 'PASS') {
    setBlocked(evidence.rollback, 'No real image exists.');
    setBlocked(evidence.rollback_verification, 'Rollback not executed.');
    return;
  }

  // Determine container port from image (reuse earlier logic)
  const inspect = run('docker', ['inspect', tag], 30000);
  if (!inspect.success) {
    evidence.rollback = { status: 'FAIL', reason: 'Unable to inspect image for rollback.', command: inspect };
    setBlocked(evidence.rollback_verification, 'Rollback failed.');
    return;
  }
  let imageInfo;
  try {
    imageInfo = JSON.parse(inspect.stdout)[0];
  } catch (e) {
    evidence.rollback = { status: 'FAIL', reason: 'Invalid inspect JSON.', command: inspect };
    setBlocked(evidence.rollback_verification, 'Rollback failed.');
    return;
  }
  const containerPort = Number(Object.keys(imageInfo.Config?.ExposedPorts || {})[0]?.split('/')[0]) || 8080;

  // Allocate a free port for rollback test (different from staging)
  const portProbe = run('powershell', ['-NoProfile', '-Command', "$l=10001..12000|%{$p=$_;try{$x=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$p);$x.Start();$x.Stop();$p;break}catch{}}"], 30000);
  const port = Number(portProbe.stdout.trim().split(/\s+/).filter(Boolean)[0]);
  if (!port) {
    setBlocked(evidence.rollback, 'Could not allocate rollback port.');
    setBlocked(evidence.rollback_verification, 'Rollback not executed.');
    return;
  }

  const good1 = `rollback-good-1-${Date.now()}`;
  const bad = `rollback-bad-${Date.now()}`;
  const good2 = `rollback-good-2-${Date.now()}`;

  // Helper to check health on port
  const checkHealth = (port) => {
    for (const path of ['/health', '/healthz', '/api/health', '/']) {
      const url = `http://127.0.0.1:${port}${path}`;
      const h = run('curl.exe', ['-sS', '-o', `${tmpdir()}/rollback-health.txt`, '-w', '%{http_code}', url], 10000);
      const code = Number(h.stdout.trim());
      if (h.success && code >= 200 && code < 400) {
        return { success: true, code, path, command: h };
      }
    }
    return { success: false };
  };

  // Step 1: Deploy good version
  const startGood1 = run('docker', ['run', '-d', '--name', good1, '-p', `${port}:${containerPort}`, tag], 60000);
  if (!startGood1.success) {
    evidence.rollback = { status: 'FAIL', phase: 'deploy-good-1', command: startGood1 };
    setBlocked(evidence.rollback_verification, 'Good version failed to start.');
    return;
  }
  // Wait for container
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  // We are in sync function, so use execSync? We'll use spawnSync sleep? Actually we need to wait. We can use Atomics.wait or just call run('powershell', ['Start-Sleep','-Seconds','4']). Simpler: use `run('powershell', ['-Command','Start-Sleep -Seconds 4'], 10000)`.
  run('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 4'], 15000);
  const health1 = checkHealth(port);
  if (!health1.success) {
    evidence.rollback = { status: 'FAIL', phase: 'health-good-1', port, command: health1.command || null };
    setBlocked(evidence.rollback_verification, 'Good version health check failed.');
    // Cleanup
    run('docker', ['rm', '-f', good1], 10000);
    return;
  }

  // Step 2: Stop good and deploy bad (simulate bad release)
  run('docker', ['rm', '-f', good1], 10000);
  const startBad = run('docker', ['run', '-d', '--name', bad, '-p', `${port}:${containerPort}`, tag, 'sh', '-c', 'exit 1'], 60000);
  // Even if startBad succeeds (container starts then exits), we check if it's running
  // Wait a moment for it to exit
  run('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3'], 15000);
  const psBad = run('docker', ['ps', '--filter', `name=^${bad}$`, '--format', '{{.Status}}'], 10000);
  const badRunning = psBad.success && psBad.stdout.trim() !== '';
  if (badRunning) {
    // If bad is still running unexpectedly, fail rollback test
    evidence.rollback = { status: 'FAIL', phase: 'bad-version-should-fail', badContainer: bad, statusOutput: psBad.stdout };
    setBlocked(evidence.rollback_verification, 'Bad version did not fail as expected.');
    run('docker', ['rm', '-f', bad], 10000);
    return;
  }

  // Step 3: Rollback - remove bad and redeploy good
  run('docker', ['rm', '-f', bad], 10000);
  const startGood2 = run('docker', ['run', '-d', '--name', good2, '-p', `${port}:${containerPort}`, tag], 60000);
  if (!startGood2.success) {
    evidence.rollback = { status: 'FAIL', phase: 'redeploy-good', command: startGood2 };
    setBlocked(evidence.rollback_verification, 'Rollback deployment failed.');
    return;
  }
  run('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 4'], 15000);
  const health2 = checkHealth(port);
  if (!health2.success) {
    evidence.rollback = { status: 'FAIL', phase: 'health-good-2', port, command: health2.command || null };
    setBlocked(evidence.rollback_verification, 'Health check after rollback failed.');
    run('docker', ['rm', '-f', good2], 10000);
    return;
  }

  // Success
  evidence.rollback = {
    status: 'PASS',
    steps: {
      good_initial: { container: good1, health: health1 },
      bad_deployment: { container: bad, expected_failure: true, running: badRunning },
      rollback_redeploy: { container: good2, health: health2 }
    },
    port,
    containerPort
  };
  evidence.rollback_verification = {
    status: 'PASS',
    reason: 'Bad version failed, rollback to good version succeeded.'
  };
  // Cleanup rollback containers (good2 remains, but we'll remove in cleanup())
}

/*
 * REGRESSION
 */
function regression() {
  const typecheck = run(NPM, ['run', 'typecheck'], 300000);
  const buildResult = run(NPM, ['run', 'build'], 300000);
  const phase1 = existsSync(join(root, 'scripts', 'verify-phase1.mjs'))
    ? run(NODE, ['scripts/verify-phase1.mjs'], 300000)
    : null;
  const phase3Rollback = existsSync(join(root, 'scripts', 'verify-phase3-rollback.ps1'))
    ? run(WIN ? 'powershell.exe' : 'powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/verify-phase3-rollback.ps1'], 300000)
    : null;
  evidence.regression = {
    status: typecheck.success && buildResult.success ? 'PASS' : 'FAIL',
    typecheck,
    build: buildResult,
    verifyPhase1: phase1,
    verifyPhase3Rollback: phase3Rollback
  };
}

/*
 * CLEANUP
 */
function cleanup() {
  // Remove any rollback containers that might still exist
  const rollbackContainers = [
    evidence.rollback?.steps?.good_initial?.container,
    evidence.rollback?.steps?.bad_deployment?.container,
    evidence.rollback?.steps?.rollback_redeploy?.container
  ].filter(Boolean);
  for (const name of rollbackContainers) {
    run('docker', ['rm', '-f', name], 10000);
  }
  // Remove staging container
  if (evidence.staging?.containerName) {
    run('docker', ['rm', '-f', container], 30000);
  }
  // Remove image
  if (evidence.docker.status === 'PASS') {
    run('docker', ['rmi', tag], 30000);
  }
}

/*
 * MAIN
 */
async function main() {
  console.log('========================================');
  console.log('NEXUS PHASE 3 - PASS 5 REAL VERIFICATION');
  console.log('========================================');

  probe();
  build();
  sbom();
  dockerBuild();
  security();
  imageSbom();
  await stagingHealth();
  smoke();
  gate();
  rollback();
  regression();

  console.log('\nCAPABILITIES');
  for (const [key, value] of Object.entries(evidence.capabilities)) {
    if (key === 'capabilities_details') continue;
    console.log(`${key}: ${value === null ? 'NOT_TESTED' : value ? 'PASS' : 'FAIL'}`);
  }

  console.log('\nRUNTIME');
  const runtimeStages = ['build', 'sbom', 'docker', 'image', 'container_security', 'image_sbom', 'staging', 'health', 'smoke', 'quality_gate', 'rollback', 'rollback_verification'];
  for (const stage of runtimeStages) {
    console.log(`${stage}: ${evidence[stage].status || 'NOT_EXECUTED'}`);
  }
  console.log(`REGRESSION: ${evidence.regression.status}`);

  const required = [
    'build', 'sbom', 'docker', 'image', 'container_security', 'image_sbom',
    'staging', 'health', 'smoke', 'quality_gate', 'rollback', 'rollback_verification', 'regression'
  ].map(key => evidence[key]?.status);
  const final = required.includes('FAIL') ? 'FAIL' : required.includes('BLOCKED') ? 'BLOCKED' : 'PASS';

  evidence.final_status = final;
  evidence.finished_at = new Date().toISOString();
  writeFileSync(join(root, 'pass5-evidence.json'), JSON.stringify(evidence, null, 2));

  console.log('\n========================================');
  console.log(`FINAL STATUS: ${final}`);
  console.log('========================================');
  console.log('Evidence: pass5-evidence.json');

  cleanup();
  process.exitCode = final === 'PASS' ? 0 : 1;
}

main().catch(error => {
  evidence.final_status = 'FAIL';
  evidence.fatal_error = String(error.stack || error);
  writeFileSync(join(root, 'pass5-evidence.json'), JSON.stringify(evidence, null, 2));
  console.error(error);
  process.exitCode = 1;
});