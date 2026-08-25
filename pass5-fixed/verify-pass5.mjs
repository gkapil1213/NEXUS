import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const WIN = process.platform === 'win32';
const NODE = process.execPath;
const NPM = 'npm';
const NPX = 'npx';

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

  let command = exe;
  let commandArgs = args;

  /*
   * Windows cannot reliably spawn npm.cmd/npx.cmd directly through
   * spawnSync(..., shell:false).
   *
   * Use cmd.exe explicitly.
   */
  if (WIN && (exe === 'npm' || exe === 'npm.cmd')) {
    command = 'cmd.exe';
    commandArgs = ['/d', '/s', '/c', 'npm.cmd', ...args];
  } else if (WIN && (exe === 'npx' || exe === 'npx.cmd')) {
    command = 'cmd.exe';
    commandArgs = ['/d', '/s', '/c', 'npx.cmd', ...args];
  } else if (WIN && exe === 'powershell') {
    command = 'powershell.exe';
  }

  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: false
  });

  return {
    success: result.status === 0,
    exitCode: result.status,
    signal: result.signal || null,
    error: result.error
      ? String(result.error.message || result.error)
      : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    duration_ms: Date.now() - started
  };
}

// ----- START ADDED HELPERS -----
function findFilesRecursive(dir, filename) {
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFilesRecursive(fullPath, filename));
      } else if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
        results.push(fullPath);
      }
    }
  } catch (_) { /* ignore */ }
  return results;
}

function resolveNativeTrivy() {
  const candidates = [];
  // 1. PATH
  candidates.push('trivy', 'trivy.exe');
  // 2. WinGet Links
  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) {
    candidates.push(join(localAppData, 'Microsoft', 'WinGet', 'Links', 'trivy.exe'));
    // 3. WinGet Packages recursive
    const packagesDir = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    if (existsSync(packagesDir)) {
      const found = findFilesRecursive(packagesDir, 'trivy.exe');
      candidates.push(...found);
    }
  }
  // 4. Program Files
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  candidates.push(
    join(programFiles, 'Trivy', 'trivy.exe'),
    join(programFiles, 'Aqua Security', 'Trivy', 'trivy.exe'),
    join(programFilesX86, 'Trivy', 'trivy.exe'),
    join(programFilesX86, 'Aqua Security', 'Trivy', 'trivy.exe')
  );

  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = candidate;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (resolved.includes('\\') && !existsSync(resolved)) continue;

    const result = spawnSync(resolved, ['--version'], {
      encoding: 'utf8',
      shell: false,
      timeout: 15000,
    });
    if (result.status === 0 && result.stdout) {
      const versionMatch = result.stdout.match(/Version:\s*(\d+\.\d+\.\d+)/);
      if (versionMatch) {
        return {
          success: true,
          path: resolved,
          version: versionMatch[1],
          exitCode: 0,
          via: resolved.includes('\\') ? 'absolute-path' : 'path-env',
        };
      }
    }
  }
  return { success: false, error: 'No working native Trivy found' };
}

function runExecutable(exePath, args = [], timeout = 120000) {
  const started = Date.now();
  try {
    const result = spawnSync(exePath, args, {
      cwd: root,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      shell: false
    });
    return {
      success: result.status === 0,
      exitCode: result.status,
      signal: result.signal || null,
      error: result.error ? String(result.error.message || result.error) : null,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      duration_ms: Date.now() - started
    };
  } catch (e) {
    return {
      success: false,
      error: e.message,
      stdout: '',
      stderr: '',
      duration_ms: Date.now() - started
    };
  }
}
// ----- END ADDED HELPERS -----

function setBlocked(target, reason) {
  target.status = 'BLOCKED';
  target.reason = reason;
  return target;
}

/*
 * Execute Trivy natively when available.
 *
 * If native Trivy is unavailable, use the real Docker Trivy image.
 *
 * This is NOT a simulated scanner.
 */
function trivyRun(args, timeout = 600000) {
  // Use native Trivy if available and resolved
  if (evidence.capabilities.trivyNative && evidence.trivyNative?.path) {
    return runExecutable(evidence.trivyNative.path, args, timeout);
  }

  // Fallback to Docker Trivy
  if (evidence.capabilities.trivyDocker) {
    return run(
      'docker',
      [
        'run',
        '--rm',

        '--mount',
        `type=bind,source=${root},target=/work`,

        '-w',
        '/work',

        'aquasec/trivy:0.74.0',

        ...args
      ],
      timeout
    );
  }

  return {
    success: false,
    exitCode: null,
    signal: null,
    error: 'No usable Trivy provider',
    stdout: '',
    stderr: '',
    duration_ms: 0
  };
}

/*
 * Probe the actual environment.
 *
 * Chromium is NOT detected through:
 *   - package.json
 *   - Playwright metadata
 *   - --dry-run
 *
 * It is detected through a REAL chromium.launch().
 */
function probe() {
  // --- Node check (was missing) ---
  const nodeCheck = run(
    NODE,
    ['--version'],
    15000
  );

  // --- Resolve native Trivy ---
  const trivyResolution = resolveNativeTrivy();
  evidence.trivyNative = trivyResolution.success ? trivyResolution : null;

  const trivyNativeCheck = trivyResolution.success
    ? runExecutable(trivyResolution.path, ['--version'], 15000)
    : { success: false, status: null, error: 'Native Trivy executable not found' };

  // --- Other checks ---
  const npmCheck = run(
    NPM,
    ['--version'],
    15000
  );

  const gitCheck = run(
    'git',
    ['--version'],
    15000
  );

  const dockerCheck = run(
    'docker',
    ['version', '--format', '{{.Client.Version}}'],
    15000
  );

  const dockerDaemonCheck = dockerCheck.success
    ? run(
        'docker',
        ['info'],
        30000
      )
    : null;

  // ========== FIXED: Probe Docker Trivy independently ==========
  const trivyDockerCheck =
    dockerDaemonCheck?.success
      ? run(
          'docker',
          [
            'run',
            '--rm',
            'aquasec/trivy:0.74.0',
            '--version'
          ],
          120000
        )
      : null;

  const playwrightCheck = run(
    NPX,
    ['playwright', '--version'],
    30000
  );

  const smokeSpec = existsSync(
    join(
      root,
      'tests',
      'smoke',
      'nexus-staging.spec.ts'
    )
  )
    ? 'tests/smoke/nexus-staging.spec.ts'
    : null;

  /*
   * REAL Chromium launch.
   *
   * This is the authoritative browser capability check.
   */
  let chromiumCheck = null;
  let chromiumAvailable = false;

  if (playwrightCheck.success) {
    chromiumCheck = run(
      NODE,
      [
        '-e',
        `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true
  });

  await browser.close();

  process.exit(0);
})().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
`
      ],
      120000
    );

    chromiumAvailable = chromiumCheck.success;
  }

  evidence.capabilities = {
    node: nodeCheck.success
      ? nodeCheck.stdout.trim()
      : null,

    npm: npmCheck.success
      ? npmCheck.stdout.trim()
      : null,

    git: gitCheck.success
      ? gitCheck.stdout.trim()
      : null,

    docker: dockerCheck.success,

    docker_daemon: !!dockerDaemonCheck?.success,

    trivy:
      trivyNativeCheck.success ||
      !!trivyDockerCheck?.success,

    trivyNative:
      trivyNativeCheck.success,

    trivyDocker:
      !!trivyDockerCheck?.success,

    playwright:
      playwrightCheck.success,

    chromium:
      chromiumAvailable,

    chromiumCheck,

    smokeSpec:
      !!smokeSpec
  };
}

function build() {
  const typecheck = run(
    NPM,
    ['run', 'typecheck'],
    300000
  );

  const buildResult = run(
    NPM,
    ['run', 'build'],
    300000
  );

  evidence.typescript_build = {
    typecheck,
    build: buildResult
  };

  evidence.build = {
    status:
      typecheck.success &&
      buildResult.success
        ? 'PASS'
        : 'FAIL',

    typecheck,
    build: buildResult
  };
}

function sbom() {
  if (!evidence.capabilities.trivy) {
    return setBlocked(
      evidence.sbom,
      'No usable native Trivy or Docker Trivy provider.'
    );
  }

  const filename =
    `.nexus-pass5-sbom-${Date.now()}.json`;

  const file = join(
    root,
    filename
  );

  /*
   * Native Trivy writes directly to the host.
   *
   * Docker Trivy writes to /work, which is mapped to root.
   */
  const outputPath =
    evidence.capabilities.trivyNative
      ? file
      : `/work/${filename}`;

  const args = [
    'fs',
    '--format',
    'cyclonedx',
    '--output',
    outputPath,
    '.'
  ];

  const result = trivyRun(
    args,
    300000
  );

  if (
    !result.success ||
    !existsSync(file)
  ) {
    evidence.sbom = {
      status: 'FAIL',
      command: result
    };

    return;
  }

  try {
    const document = JSON.parse(
      readFileSync(file, 'utf8')
    );

    const components =
      Array.isArray(document.components)
        ? document.components.length
        : 0;

    evidence.sbom = {
      status:
        document.bomFormat === 'CycloneDX' &&
        components > 0
          ? 'PASS'
          : 'FAIL',

      file,
      format:
        document.bomFormat || null,

      components,

      command: result
    };
  } catch (error) {
    evidence.sbom = {
      status: 'FAIL',
      reason: error.message,
      command: result
    };
  }
}

function dockerBuild() {
  if (!evidence.capabilities.docker_daemon) {
    setBlocked(
      evidence.docker,
      'Docker daemon unavailable.'
    );

    return;
  }

  const buildResult = run(
    'docker',
    [
      'build',
      '-t',
      tag,
      '.'
    ],
    600000
  );

  if (!buildResult.success) {
    evidence.docker = {
      status: 'FAIL',
      command: buildResult
    };

    setBlocked(
      evidence.image,
      'Docker build failed.'
    );

    return;
  }

  const inspectResult = run(
    'docker',
    [
      'inspect',
      tag
    ],
    30000
  );

  if (!inspectResult.success) {
    evidence.docker = {
      status: 'FAIL',
      build: buildResult,
      inspect: inspectResult
    };

    return;
  }

  try {
    const inspected =
      JSON.parse(
        inspectResult.stdout
      )[0];

    evidence.docker = {
      status: 'PASS',

      tag,

      imageId:
        inspected.Id,

      digest:
        inspected.RepoDigests?.[0] ||
        null,

      build:
        buildResult
    };

    evidence.image = {
      status: 'PASS',

      imageId:
        inspected.Id,

      repoTags:
        inspected.RepoTags || [],

      architecture:
        inspected.Architecture,

      created:
        inspected.Created,

      config:
        inspected.Config || {},

      digest:
        inspected.RepoDigests?.[0] ||
        null
    };
  } catch (error) {
    evidence.docker = {
      status: 'FAIL',
      reason:
        `Invalid docker inspect JSON: ${error.message}`,
      build: buildResult,
      inspect: inspectResult
    };
  }
}

function containerSecurity() {
  if (evidence.docker.status !== 'PASS') {
    return setBlocked(
      evidence.container_security,
      'No real image exists.'
    );
  }

  if (!evidence.capabilities.trivy) {
    return setBlocked(
      evidence.container_security,
      'Trivy unavailable.'
    );
  }

  const result = trivyRun(
    [
      'image',
      '--format',
      'json',
      tag
    ],
    600000
  );

  if (!result.success) {
    evidence.container_security = {
      status: 'FAIL',
      command: result
    };

    return;
  }

  try {
    const document =
      JSON.parse(result.stdout);

    const counts = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      UNKNOWN: 0
    };

    for (
      const target of
      document.Results || []
    ) {
      for (
        const vulnerability of
        target.Vulnerabilities || []
      ) {
        if (
          counts[
            vulnerability.Severity
          ] !== undefined
        ) {
          counts[
            vulnerability.Severity
          ]++;
        }
      }
    }

    evidence.container_security = {
      status: 'PASS',

      scanner:
        evidence.capabilities.trivyNative
          ? 'trivy-native'
          : 'trivy-docker',

      image:
        tag,

      critical:
        counts.CRITICAL,

      high:
        counts.HIGH,

      medium:
        counts.MEDIUM,

      low:
        counts.LOW,

      unknown:
        counts.UNKNOWN,

      command:
        result
    };
  } catch (error) {
    evidence.container_security = {
      status: 'FAIL',
      reason: error.message,
      command: result
    };
  }
}

function imageSbom() {
  if (evidence.docker.status !== 'PASS') {
    return setBlocked(
      evidence.image_sbom,
      'No real image exists.'
    );
  }

  if (!evidence.capabilities.trivy) {
    return setBlocked(
      evidence.image_sbom,
      'Trivy unavailable.'
    );
  }

  const filename =
    `.nexus-pass5-image-${Date.now()}.json`;

  const file = join(
    root,
    filename
  );

  const outputPath =
    evidence.capabilities.trivyNative
      ? file
      : `/work/${filename}`;

  const result = trivyRun(
    [
      'image',
      '--format',
      'cyclonedx',
      '--output',
      outputPath,
      tag
    ],
    600000
  );

  if (
    !result.success ||
    !existsSync(file)
  ) {
    evidence.image_sbom = {
      status: 'FAIL',
      command: result
    };

    return;
  }

  try {
    const document =
      JSON.parse(
        readFileSync(file, 'utf8')
      );

    const components =
      Array.isArray(document.components)
        ? document.components.length
        : 0;

    evidence.image_sbom = {
      status:
        document.bomFormat === 'CycloneDX' &&
        components > 0
          ? 'PASS'
          : 'FAIL',

      image:
        tag,

      file,

      components,

      format:
        document.bomFormat || null,

      command:
        result
    };
  } catch (error) {
    evidence.image_sbom = {
      status: 'FAIL',
      reason: error.message,
      command: result
    };
  }
}

async function stagingHealth() {
  if (evidence.docker.status !== 'PASS') {
    setBlocked(
      evidence.staging,
      'No built image.'
    );

    setBlocked(
      evidence.health,
      'No staging deployment.'
    );

    return;
  }

  const inspectResult = run(
    'docker',
    [
      'inspect',
      tag
    ],
    30000
  );

  if (!inspectResult.success) {
    evidence.staging = {
      status: 'FAIL',
      reason:
        'Unable to inspect built image.',
      command:
        inspectResult
    };

    setBlocked(
      evidence.health,
      'Image inspection failed.'
    );

    return;
  }

  let imageInfo;

  try {
    imageInfo =
      JSON.parse(
        inspectResult.stdout
      )[0];
  } catch (error) {
    evidence.staging = {
      status: 'FAIL',
      reason:
        `Invalid docker inspect JSON: ${error.message}`,
      command:
        inspectResult
    };

    setBlocked(
      evidence.health,
      'Invalid image inspection.'
    );

    return;
  }

  const exposedPorts =
    Object.keys(
      imageInfo.Config?.ExposedPorts || {}
    )
      .map(
        value =>
          Number(
            String(value)
              .split('/')[0]
          )
      )
      .filter(
        Number.isInteger
      );

  const containerPort =
    exposedPorts[0] || 8080;

  /*
   * Find a free host port.
   */
  const portProbe =
    WIN
      ? run(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `
$found = $null
foreach ($p in 8000..10000) {
  try {
    $listener = [Net.Sockets.TcpListener]::new(
      [Net.IPAddress]::Loopback,
      $p
    )
    $listener.Start()
    $listener.Stop()
    $found = $p
    break
  }
  catch {}
}

if ($null -ne $found) {
  Write-Output $found
}
`
          ],
          30000
        )
      : null;

  const port =
    Number(
      portProbe?.stdout
        ?.trim()
        ?.split(/\s+/)
        ?.filter(Boolean)
        ?.at(0)
    );

  if (!port) {
    setBlocked(
      evidence.staging,
      'Could not allocate a host port.'
    );

    setBlocked(
      evidence.health,
      'Staging was not started.'
    );

    return;
  }

  const runResult = run(
    'docker',
    [
      'run',
      '-d',

      '--name',
      container,

      '-p',
      `${port}:${containerPort}`,

      tag
    ],
    120000
  );

  if (!runResult.success) {
    evidence.staging = {
      status: 'FAIL',

      containerName:
        container,

      hostPort:
        port,

      containerPort,

      image:
        tag,

      command:
        runResult
    };

    setBlocked(
      evidence.health,
      'Staging container failed to start.'
    );

    return;
  }

  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        4000
      )
  );

  const processCheck = run(
    'docker',
    [
      'ps',

      '--filter',
      `name=^${container}$`,

      '--format',
      '{{.Status}}'
    ],
    30000
  );

  const running =
    processCheck.success &&
    !!processCheck.stdout.trim();

  evidence.staging = {
    status:
      running
        ? 'PASS'
        : 'FAIL',

    containerName:
      container,

    hostPort:
      port,

    containerPort,

    image:
      tag,

    command:
      runResult,

    statusOutput:
      processCheck.stdout.trim()
  };

  if (!running) {
    const logs = run(
      'docker',
      [
        'logs',
        container
      ],
      30000
    );

    evidence.staging.logs =
      logs;

    setBlocked(
      evidence.health,
      'Container is not running.'
    );

    return;
  }

  /*
   * Try configured and conventional health endpoints.
   */
  const candidates = [
    process.env.NEXUS_HEALTH_PATH,
    '/health',
    '/healthz',
    '/api/health',
    '/'
  ].filter(Boolean);

  for (
    const path of
    [...new Set(candidates)]
  ) {
    const url =
      `http://127.0.0.1:${port}${path}`;

    const healthResult =
      WIN
        ? run(
            'curl.exe',
            [
              '-sS',
              '-o',
              join(
                tmpdir(),
                'nexus-pass5-health.txt'
              ),
              '-w',
              '%{http_code}',
              url
            ],
            20000
          )
        : run(
            'curl',
            [
              '-sS',
              '-o',
              join(
                tmpdir(),
                'nexus-pass5-health.txt'
              ),
              '-w',
              '%{http_code}',
              url
            ],
            20000
          );

    const statusCode =
      Number(
        healthResult.stdout.trim()
      );

    if (
      healthResult.success &&
      statusCode >= 200 &&
      statusCode < 400
    ) {
      evidence.health = {
        status: 'PASS',

        url,

        endpoint:
          path,

        http_status:
          statusCode,

        command:
          healthResult
      };

      return;
    }
  }

  const logs = run(
    'docker',
    [
      'logs',
      container
    ],
    30000
  );

  evidence.health = {
    status: 'FAIL',

    reason:
      'No health endpoint returned HTTP 2xx/3xx.',

    container,

    command:
      logs,

    logs
  };
}

function smoke() {
  if (
    evidence.staging.status !== 'PASS' ||
    evidence.health.status !== 'PASS'
  ) {
    return setBlocked(
      evidence.smoke,
      'Real staging/health did not pass.'
    );
  }

  const spec =
    existsSync(
      join(
        root,
        'tests',
        'smoke',
        'nexus-staging.spec.ts'
      )
    )
      ? 'tests/smoke/nexus-staging.spec.ts'
      : null;

  if (!spec) {
    return setBlocked(
      evidence.smoke,
      'Existing staging smoke spec not found.'
    );
  }

  if (!evidence.capabilities.playwright) {
    return setBlocked(
      evidence.smoke,
      'Playwright CLI is unavailable.'
    );
  }

  if (!evidence.capabilities.chromium) {
    return setBlocked(
      evidence.smoke,
      'Real Chromium launch failed.'
    );
  }

  const result = run(
    NPX,
    [
      'playwright',
      'test',
      spec
    ],
    600000
  );

  evidence.smoke = {
    status:
      result.success
        ? 'PASS'
        : 'FAIL',

    browser_proof:
      result.success
        ? 'Real Playwright browser execution succeeded.'
        : 'Real Playwright browser execution failed.',

    command:
      result
  };
}

function gate() {
  const stages = [
    'build',
    'sbom',
    'docker',
    'image',
    'container_security',
    'image_sbom',
    'staging',
    'health',
    'smoke'
  ];

  const statuses =
    stages.map(
      key =>
        evidence[key]?.status
    );

  evidence.quality_gate = {
    status:
      statuses.includes('FAIL')
        ? 'FAIL'
        : statuses.includes('BLOCKED')
          ? 'BLOCKED'
          : 'PASS',

    checks:
      Object.fromEntries(
        stages.map(
          key => [
            key,
            evidence[key]?.status ||
              'UNKNOWN'
          ]
        )
      )
  };
}

/*
 * Rollback is deliberately NOT simulated.
 *
 * A real two-version rollback fixture must exist before
 * this can become PASS.
 */
function rollback() {
  setBlocked(
    evidence.rollback,
    'No safe real two-version rollback fixture was executed.'
  );

  setBlocked(
    evidence.rollback_verification,
    'Rollback was not executed; no simulation is allowed.'
  );
}

function regression() {
  const typecheck = run(
    NPM,
    ['run', 'typecheck'],
    300000
  );

  const buildResult = run(
    NPM,
    ['run', 'build'],
    300000
  );

  const phase1 =
    existsSync(
      join(
        root,
        'scripts',
        'verify-phase1.mjs'
      )
    )
      ? run(
          NODE,
          ['scripts/verify-phase1.mjs'],
          300000
        )
      : null;

  const phase3Rollback =
    existsSync(
      join(
        root,
        'scripts',
        'verify-phase3-rollback.ps1'
      )
    )
      ? run(
          WIN
            ? 'powershell.exe'
            : 'powershell',
          [
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'scripts/verify-phase3-rollback.ps1'
          ],
          300000
        )
      : null;

  evidence.regression = {
    status:
      typecheck.success &&
      buildResult.success
        ? 'PASS'
        : 'FAIL',

    typecheck,

    build:
      buildResult,

    verifyPhase1:
      phase1,

    verifyPhase3Rollback:
      phase3Rollback
  };
}

function cleanup() {
  if (
    evidence.staging?.containerName
  ) {
    run(
      'docker',
      [
        'rm',
        '-f',
        container
      ],
      30000
    );
  }

  if (
    evidence.docker.status === 'PASS'
  ) {
    run(
      'docker',
      [
        'rmi',
        tag
      ],
      30000
    );
  }
}

async function main() {
  console.log(
    '========================================\n' +
    'NEXUS PHASE 3 — PASS 5 REAL VERIFICATION\n' +
    '========================================'
  );

  probe();

  console.log('\nCAPABILITIES');

  for (
    const [key, value]
    of Object.entries(
      evidence.capabilities
    )
  ) {
    console.log(
      `${key}: ${value ? 'PASS' : 'FAIL'}`
    );
  }

  build();

  sbom();

  dockerBuild();

  containerSecurity();

  imageSbom();

  await stagingHealth();

  smoke();

  gate();

  rollback();

  regression();

  console.log('\nRUNTIME');

  for (
    const key of [
      'sbom',
      'docker',
      'image',
      'container_security',
      'image_sbom',
      'staging',
      'health',
      'smoke',
      'quality_gate',
      'rollback',
      'rollback_verification'
    ]
  ) {
    console.log(
      `${key}: ${evidence[key].status}`
    );
  }

  console.log(
    `REGRESSION: ${evidence.regression.status}`
  );

  const required = [
    'build',
    'sbom',
    'docker',
    'image',
    'container_security',
    'image_sbom',
    'staging',
    'health',
    'smoke',
    'quality_gate',
    'rollback',
    'rollback_verification',
    'regression'
  ];

  const statuses =
    required.map(
      key =>
        evidence[key]?.status
    );

  const final =
    statuses.includes('FAIL')
      ? 'FAIL'
      : statuses.includes('BLOCKED')
        ? 'BLOCKED'
        : 'PASS';

  evidence.final_status =
    final;

  evidence.finished_at =
    new Date().toISOString();

  writeFileSync(
    join(
      root,
      'pass5-evidence.json'
    ),
    JSON.stringify(
      evidence,
      null,
      2
    )
  );

  console.log(
    '\n========================================\n' +
    `FINAL STATUS: ${final}\n` +
    '========================================\n' +
    'Evidence: pass5-evidence.json'
  );

  cleanup();

  process.exitCode =
    final === 'PASS'
      ? 0
      : 1;
}

main().catch(error => {
  evidence.final_status =
    'FAIL';

  evidence.fatal_error =
    String(
      error.stack ||
      error
    );

  evidence.finished_at =
    new Date().toISOString();

  writeFileSync(
    join(
      root,
      'pass5-evidence.json'
    ),
    JSON.stringify(
      evidence,
      null,
      2
    )
  );

  console.error(error);

  process.exitCode = 1;
});