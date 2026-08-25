function scannerBlocked(scanner, reason, extra = {}) {
  return {
    success: false,
    status: 'BLOCKED',
    scanner,
    error: reason,
    findings: [],
    ...extra
  };
}

function scannerFailed(scanner, reason, result = null, extra = {}) {
  return {
    success: false,
    status: 'FAIL',
    scanner,
    error: reason,
    findings: [],
    command: result,
    ...extra
  };
}

function scannerPassed(scanner, findings, result = null, extra = {}) {
  return {
    success: true,
    status: 'PASS',
    scanner,
    findings,
    command: result,
    ...extra
  };
}

// CORRECTED: strips leading non-JSON output (npm deprecation warnings etc.)
// before attempting to parse, instead of parsing the raw trimmed string directly.
function parseJsonOutput(stdout, stderr = '') {
  const text = String(stdout || '').trim();

  if (!text) {
    return {
      success: false,
      error: String(stderr || 'Scanner returned no JSON output.')
    };
  }

  const start = text.indexOf('{');
  const jsonSlice = start >= 0 ? text.slice(start) : text;

  try {
    return {
      success: true,
      data: JSON.parse(jsonSlice)
    };
  } catch (error) {
    return {
      success: false,
      error: `Invalid JSON scanner output: ${error.message}`,
      raw: text.slice(0, 10000)
    };
  }
}


// ============================================================
// NPM AUDIT  (unchanged from your document)
// ============================================================

function runNpmAudit() {
  if (!evidence.capabilities.npmAudit) {
    return scannerBlocked('npm-audit', 'npm audit executable is unavailable.');
  }

  const result = run(NPM, ['audit', '--json'], 300000);
  const parsed = parseJsonOutput(result.stdout, result.stderr);

  if (!parsed.success) {
    return scannerFailed('npm-audit', parsed.error, result);
  }

  const findings = [];

  if (parsed.data.vulnerabilities) {
    for (const [packageName, vulnerability] of Object.entries(parsed.data.vulnerabilities)) {
      const severityMap = { critical: 'CRITICAL', high: 'HIGH', moderate: 'MEDIUM', low: 'LOW', info: 'INFO' };
      const severity = severityMap[String(vulnerability.severity || 'unknown').toLowerCase()] || 'UNKNOWN';

      findings.push({
        id: `npm-audit-${packageName}-${Date.now()}`,
        scanner: 'npm-audit',
        category: 'DEPENDENCY',
        severity,
        title: `Dependency vulnerability: ${packageName}`,
        package: packageName,
        version: vulnerability.range || '',
        fixed_version: Array.isArray(vulnerability.fixAvailable) ? '' : vulnerability.fixAvailable?.version || '',
        evidence: { via: 'npm audit', raw: vulnerability }
      });
    }
  }

  if (parsed.data.advisories) {
    for (const [id, advisory] of Object.entries(parsed.data.advisories)) {
      const severityMap = { critical: 'CRITICAL', high: 'HIGH', moderate: 'MEDIUM', low: 'LOW' };
      const severity = severityMap[String(advisory.severity || '').toLowerCase()] || 'UNKNOWN';

      findings.push({
        id: `npm-audit-${id}`,
        scanner: 'npm-audit',
        category: 'DEPENDENCY',
        severity,
        title: advisory.title || advisory.name || id,
        package: advisory.module_name || '',
        version: advisory.findings?.[0]?.version || '',
        fixed_version: advisory.patches?.[0]?.version || '',
        cve: Array.isArray(advisory.cves) ? advisory.cves.join(', ') : '',
        evidence: advisory
      });
    }
  }

  return scannerPassed('npm-audit', findings, result);
}


// ============================================================
// GITLEAKS  (unchanged from your document)
// ============================================================

function runGitleaks() {
  if (!evidence.capabilities.gitleaks) {
    return scannerBlocked('gitleaks', 'Gitleaks executable is unavailable.');
  }

  const reportFile = join(root, `.nexus-gitleaks-${Date.now()}.json`);

  const result = run('gitleaks', [
    'detect', '--source', root, '--report-format', 'json', '--report-path', reportFile, '--no-banner'
  ], 300000);

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return scannerFailed('gitleaks', result.error || `Gitleaks execution failed with exit code ${result.exitCode}.`, result);
  }

  if (!existsSync(reportFile)) {
    return scannerFailed('gitleaks', 'Gitleaks completed but did not produce the expected JSON report.', result);
  }

  let data;
  try {
    const raw = readFileSync(reportFile, 'utf8');
    data = raw.trim() ? JSON.parse(raw) : [];
  } catch (error) {
    return scannerFailed('gitleaks', `Unable to parse Gitleaks report: ${error.message}`, result);
  }

  const leaks = Array.isArray(data) ? data : Array.isArray(data.leaks) ? data.leaks : [];

  const findings = leaks.map((leak, index) => ({
    id: `gitleaks-${Date.now()}-${index}`,
    scanner: 'gitleaks',
    category: 'SECRET',
    severity: String(leak.Severity || 'HIGH').toUpperCase(),
    title: `Secret detected: ${leak.RuleID || 'unknown-rule'}`,
    description: leak.Description || leak.RuleID || 'Potential secret detected.',
    file: leak.File || '',
    line: leak.StartLine || leak.Line || null,
    rule_id: leak.RuleID || '',
    evidence: {
      file: leak.File || '',
      line: leak.StartLine || leak.Line || null,
      secret_type: leak.RuleID || '',
      fingerprint: leak.Fingerprint || null
    }
  }));

  return scannerPassed('gitleaks', findings, result, { reportFile, exitCode: result.exitCode });
}


// ============================================================
// SEMGREP  (unchanged from your document)
// ============================================================

function runSemgrep() {
  if (!evidence.capabilities.semgrep) {
    return scannerBlocked('semgrep', 'Semgrep executable is unavailable.');
  }

  const result = run('semgrep', [
    'scan', '--json', '--config=p/security-audit', '--no-ignore',
    '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'test-results', '--exclude', 'trivy-*.json', '.'
  ], 600000);

  const parsed = parseJsonOutput(result.stdout, result.stderr);
  if (!parsed.success) {
    return scannerFailed('semgrep', parsed.error, result);
  }

  const findings = [];
  for (const [index, res] of (parsed.data.results || []).entries()) {
    const rawSeverity = String(res.extra?.severity || 'MEDIUM').toUpperCase();
    const severity = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(rawSeverity) ? rawSeverity : 'UNKNOWN';

    findings.push({
      id: `semgrep-${Date.now()}-${index}`,
      scanner: 'semgrep',
      category: 'SAST',
      severity,
      title: res.extra?.message || res.check_id || res.rule_id || 'Semgrep finding',
      description: res.extra?.message || '',
      file: res.path || '',
      line: res.start?.line || null,
      rule_id: res.check_id || res.rule_id || '',
      cwe: Array.isArray(res.extra?.metadata?.cwe) ? res.extra.metadata.cwe.join(', ') : '',
      evidence: { raw: res }
    });
  }

  return scannerPassed('semgrep', findings, result);
}


// ============================================================
// CHECKOV  (unchanged from your document)
// ============================================================

function runCheckov() {
  if (!evidence.capabilities.checkov) {
    return scannerBlocked('checkov', 'Checkov executable is unavailable.');
  }

  const executable = evidence.checkov?.path;
  if (!executable) {
    return scannerBlocked('checkov', 'Checkov was detected but no resolved executable path exists.');
  }

  const result = run(executable, ['-d', root, '--output', 'json', '--quiet'], 600000);
  const parsed = parseJsonOutput(result.stdout, result.stderr);

  if (!parsed.success) {
    return scannerFailed('checkov', parsed.error, result);
  }

  const findings = [];
  const failedChecks = parsed.data.results?.failed_checks || [];

  for (const [index, check] of failedChecks.entries()) {
    const rawSeverity = String(check.severity || 'MEDIUM').toUpperCase();
    const severity = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].includes(rawSeverity) ? rawSeverity : 'UNKNOWN';

    findings.push({
      id: `checkov-${Date.now()}-${index}`,
      scanner: 'checkov',
      category: 'IAC',
      severity,
      title: check.check_name || check.check_id || 'Checkov finding',
      description: check.check_name || '',
      file: check.file_path || '',
      line: check.file_line_range?.[0] || null,
      rule_id: check.check_id || '',
      evidence: { raw: check }
    });
  }

  return scannerPassed('checkov', findings, result, {
    checkovVersion: evidence.checkov?.version || null,
    checkovPath: evidence.checkov?.path || null
  });
}


// ============================================================
// ZAP — REAL DAST
// CORRECTED: falls back to evidence.staging.hostPort when
// NEXUS_DAST_URL isn't set, instead of BLOCKING every run
// that forgot to export the env var manually.
// ============================================================

function runZap() {
  if (!evidence.capabilities.zap) {
    return scannerBlocked('zap', 'OWASP ZAP executable is unavailable.');
  }

  const zapJar = evidence.zap?.path;
  if (!zapJar || !existsSync(zapJar)) {
    return scannerBlocked('zap', 'Resolved ZAP JAR does not exist.');
  }

  let target = process.env.NEXUS_DAST_URL?.trim() || null;
  if (!target && evidence.staging?.hostPort && evidence.staging?.status === 'PASS') {
    target = `http://127.0.0.1:${evidence.staging.hostPort}`;
  }

  if (!target) {
    return scannerBlocked('zap', 'No DAST target configured. Set NEXUS_DAST_URL or ensure staging is running.');
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(target);
  } catch {
    return scannerFailed('zap', `Invalid NEXUS_DAST_URL: ${target}`);
  }

  const hostname = parsedTarget.hostname;
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';

  if (!loopback) {
    return scannerBlocked('zap', `DAST target is outside the loopback-only Pass 1 boundary: ${hostname}`);
  }

  const outputFile = join(root, `.nexus-zap-${Date.now()}.json`);

  const healthProbe = WIN
    ? run('curl.exe', ['-sS', '-o', join(tmpdir(), 'nexus-zap-target.txt'), '-w', '%{http_code}', target], 30000)
    : run('curl', ['-sS', '-o', join(tmpdir(), 'nexus-zap-target.txt'), '-w', '%{http_code}', target], 30000);

  const statusCode = Number(healthProbe.stdout.trim());

  if (!healthProbe.success || statusCode < 200 || statusCode >= 500) {
    return scannerBlocked('zap', `DAST target is not reachable: HTTP ${statusCode || 'unavailable'}.`, { target, healthProbe });
  }

  const result = run('java', [
    '-jar', zapJar, '-cmd', '-quickurl', target, '-quickout', outputFile, '-quickprogress'
  ], 900000, dirname(zapJar));

  if (!existsSync(outputFile)) {
    return scannerFailed('zap', 'ZAP executed but did not produce the expected report.', result, {
      target, zapVersion: evidence.zap?.version || null
    });
  }

  let report;
  try {
    report = JSON.parse(readFileSync(outputFile, 'utf8'));
  } catch (error) {
    return scannerFailed('zap', `Unable to parse ZAP JSON report: ${error.message}`, result, { target, outputFile });
  }

  const findings = [];
  const sites = Array.isArray(report.site) ? report.site : [];

  for (const site of sites) {
    const alerts = Array.isArray(site.alerts) ? site.alerts : [];
    for (const [index, alert] of alerts.entries()) {
      const risk = String(alert.riskdesc || alert.risk || 'Informational').toUpperCase();
      let severity = 'INFO';
      if (risk.includes('CRITICAL')) severity = 'CRITICAL';
      else if (risk.includes('HIGH')) severity = 'HIGH';
      else if (risk.includes('MEDIUM')) severity = 'MEDIUM';
      else if (risk.includes('LOW')) severity = 'LOW';

      findings.push({
        id: `zap-${Date.now()}-${index}`,
        scanner: 'zap',
        category: 'DAST',
        severity,
        title: alert.name || alert.alert || 'ZAP alert',
        description: alert.desc || alert.description || '',
        url: alert.url || site.name || target,
        rule_id: alert.pluginid || alert.pluginId || '',
        evidence: {
          solution: alert.solution || '',
          reference: alert.reference || '',
          confidence: alert.confidence || '',
          raw: alert
        }
      });
    }
  }

  return scannerPassed('zap', findings, result, {
    target, outputFile, zapVersion: evidence.zap?.version || null, targetStatusCode: statusCode
  });
}


// ============================================================
// SECURITY GATE
// CORRECTED: fallback status is 'UNKNOWN' instead of 'BLOCKED'
// so a buggy scanner function can't hide as "tool missing".
// ============================================================

function gate() {
  const scanners = {
    dependency: evidence.security?.dependency,
    secrets: evidence.security?.secrets,
    sast: evidence.security?.sast,
    iac: evidence.security?.iac,
    dast: evidence.security?.dast
  };

  const scannerStatuses = Object.fromEntries(
    Object.entries(scanners).map(([key, value]) => [key, value?.status || 'UNKNOWN'])
  );

  const allFindings = [];
  for (const scanner of Object.values(scanners)) {
    if (Array.isArray(scanner?.findings)) allFindings.push(...scanner.findings);
  }

  const blocked = Object.entries(scannerStatuses).filter((