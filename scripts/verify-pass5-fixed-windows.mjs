import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const WIN = process.platform === 'win32';
const NODE = process.execPath;
const NPM = 'npm';
const NPX = 'npx';
const tag = `nexus-pass5-${Date.now()}`;
const container = `nexus-pass5-staging-${Date.now()}`;
const evidence = { timestamp:new Date().toISOString(), platform:process.platform, capabilities:{}, build:{}, sbom:{}, docker:{}, image:{}, container_security:{}, image_sbom:{}, staging:{}, health:{}, smoke:{}, quality_gate:{}, rollback:{}, rollback_verification:{}, regression:{}, typescript_build:{}, files_changed:[] };

function run(exe,args=[],timeout=120000){
  const t=Date.now();
  const resolved = WIN && exe === 'npm' ? 'npm.cmd'
    : WIN && exe === 'npx' ? 'npx.cmd'
    : WIN && exe === 'powershell' ? 'powershell.exe'
    : exe;
  const r=spawnSync(resolved,args,{cwd:root,encoding:'utf8',timeout,windowsHide:true,shell:false});
  return {
    success:r.status===0,
    exitCode:r.status,
    signal:r.signal||null,
    error:r.error ? String(r.error.message||r.error) : null,
    stdout:r.stdout||'',
    stderr:r.stderr||'',
    duration_ms:Date.now()-t
  };
}
function setBlocked(obj,reason){ return Object.assign(obj,{status:'BLOCKED',reason}); }
function trivyRun(args, timeout=600000){
  const native=run('trivy',args,timeout);
  if(native.success || !evidence.capabilities.trivyDocker) return native;
  return run('docker',['run','--rm','--mount',`type=bind,source=${root},target=/work`,'--mount','type=bind,source=//var/run/docker.sock,target=/var/run/docker.sock','-w','/work','aquasec/trivy:0.74.0',...args],timeout);
}

function probe(){
  const n=run(NODE,['--version'],15000);
  const npm=run(NPM,['--version'],15000);
  const git=run('git',['--version'],15000);
  const dc=run('docker',['version','--format','{{.Client.Version}}'],15000);
  const di=dc.success?run('docker',['info'],30000):null;

  const trNative=run('trivy',['--version'],15000);
  const trDocker=(!trNative.success && !!di?.success)
    ? run('docker',['run','--rm','aquasec/trivy:0.74.0','--version'],120000)
    : null;

  const pw=run(NPX,['playwright','--version'],30000);
  const smokeSpec=existsSync(join(root,'tests','smoke','nexus-staging.spec.ts'))
    ? 'tests/smoke/nexus-staging.spec.ts' : null;

  // Do not declare Chromium available from --dry-run or package metadata.
  // A real Playwright smoke execution is the authoritative browser proof.
  evidence.capabilities={
    node:n.success?n.stdout.trim():null,
    npm:npm.success?npm.stdout.trim():null,
    git:git.success?git.stdout.trim():null,
    docker:dc.success,
    docker_daemon:!!di?.success,
    trivy:trNative.success||!!trDocker?.success,
    trivyNative:trNative.success,
    trivyDocker:!!trDocker?.success,
    playwright:pw.success,
    chromium:false,
    smokeSpec:!!smokeSpec
  };
}
function build(){ const typecheck=run(NPM,['run','typecheck'],300000), build=run(NPM,['run','build'],300000); evidence.typescript_build={typecheck,build}; evidence.build={status:typecheck.success&&build.success?'PASS':'FAIL',typecheck,build}; }
function sbom(){ if(!evidence.capabilities.trivy)return setBlocked(evidence.sbom,'No usable native Trivy or Docker Trivy provider.'); const file=join(root,`.nexus-pass5-sbom-${Date.now()}.json`); const args=['fs','--format','cyclonedx','--output', evidence.capabilities.trivyNative?file:`/work/${file.split('\\').pop()}`,'.']; const r=trivyRun(args,300000); if(!r.success||!existsSync(file)){evidence.sbom={status:'FAIL',command:r};return;} try{const d=JSON.parse(readFileSync(file,'utf8'));const c=Array.isArray(d.components)?d.components.length:0;evidence.sbom={status:d.bomFormat==='CycloneDX'&&c>0?'PASS':'FAIL',file,format:d.bomFormat||null,components:c,command:r};}catch(e){evidence.sbom={status:'FAIL',reason:e.message,command:r};} }
function dockerBuild(){ if(!evidence.capabilities.docker_daemon){setBlocked(evidence.docker,'Docker daemon unavailable.');return;} const r=run('docker',['build','-t',tag,'.'],600000); if(!r.success){evidence.docker={status:'FAIL',command:r};setBlocked(evidence.image,'Docker build failed.');return;} const i=run('docker',['inspect',tag],30000); if(!i.success){evidence.docker={status:'FAIL',build:r,inspect:i};return;} const d=JSON.parse(i.stdout)[0]; evidence.docker={status:'PASS',tag,imageId:d.Id,digest:d.RepoDigests?.[0]||null,build:r}; evidence.image={status:'PASS',imageId:d.Id,repoTags:d.RepoTags||[],architecture:d.Architecture,created:d.Created,config:d.Config||{},digest:d.RepoDigests?.[0]||null}; }
function security(){ if(evidence.docker.status!=='PASS')return setBlocked(evidence.container_security,'No real image exists.'); if(!evidence.capabilities.trivy)return setBlocked(evidence.container_security,'Trivy unavailable.'); const r=trivyRun(['image','--format','json',tag],600000); if(!r.success){evidence.container_security={status:'FAIL',command:r};return;} try{const d=JSON.parse(r.stdout),c={CRITICAL:0,HIGH:0,MEDIUM:0,LOW:0,UNKNOWN:0};for(const x of d.Results||[])for(const v of x.Vulnerabilities||[])if(c[v.Severity]!==undefined)c[v.Severity]++;evidence.container_security={status:'PASS',scanner:'trivy',image:tag,critical:c.CRITICAL,high:c.HIGH,medium:c.MEDIUM,low:c.LOW,unknown:c.UNKNOWN,command:r};}catch(e){evidence.container_security={status:'FAIL',reason:e.message,command:r};} }
function imageSbom(){ if(evidence.docker.status!=='PASS')return setBlocked(evidence.image_sbom,'No real image exists.'); if(!evidence.capabilities.trivy)return setBlocked(evidence.image_sbom,'Trivy unavailable.'); const file=join(root,`.nexus-pass5-image-${Date.now()}.json`); const args=['image','--format','cyclonedx','--output',evidence.capabilities.trivyNative?file:`/work/${file.split('\\').pop()}`,tag]; const r=trivyRun(args,600000); if(!r.success||!existsSync(file)){evidence.image_sbom={status:'FAIL',command:r};return;} try{const d=JSON.parse(readFileSync(file,'utf8'));const c=Array.isArray(d.components)?d.components.length:0;evidence.image_sbom={status:d.bomFormat==='CycloneDX'&&c>0?'PASS':'FAIL',image:tag,file,components:c,format:d.bomFormat||null,command:r};}catch(e){evidence.image_sbom={status:'FAIL',reason:e.message,command:r};}}
async function stagingHealth(){
  if(evidence.docker.status!=='PASS'){
    setBlocked(evidence.staging,'No built image.');
    setBlocked(evidence.health,'No staging deployment.');
    return;
  }

  const inspect=run('docker',['inspect',tag],30000);
  if(!inspect.success){
    evidence.staging={status:'FAIL',reason:'Unable to inspect built image.',command:inspect};
    setBlocked(evidence.health,'Image inspection failed.');
    return;
  }

  let imageInfo;
  try { imageInfo=JSON.parse(inspect.stdout)[0]; }
  catch(e){
    evidence.staging={status:'FAIL',reason:`Invalid docker inspect JSON: ${e.message}`,command:inspect};
    setBlocked(evidence.health,'Invalid image inspection.');
    return;
  }

  const exposed=Object.keys(imageInfo.Config?.ExposedPorts||{})
    .map(x=>Number(String(x).split('/')[0]))
    .filter(Number.isInteger);
  const containerPort=exposed[0] || 8080;

  const p=run(WIN?'powershell':'powershell',
    ['-NoProfile','-Command',
     "$l=8000..10000|%{$p=$_;try{$x=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$p);$x.Start();$x.Stop();$p;break}catch{}}"],
    30000);

  const port=Number(p.stdout.trim().split(/\s+/).filter(Boolean)[0]);
  if(!port){
    setBlocked(evidence.staging,'Could not allocate a host port.');
    setBlocked(evidence.health,'Staging was not started.');
    return;
  }

  const r=run('docker',['run','-d','--name',container,'-p',`${port}:${containerPort}`,tag],120000);
  if(!r.success){
    evidence.staging={status:'FAIL',containerName:container,hostPort:port,containerPort,image:tag,command:r};
    setBlocked(evidence.health,'Staging container failed to start.');
    return;
  }

  await new Promise(x=>setTimeout(x,4000));

  const ps=run('docker',['ps','--filter',`name=^${container}$`,'--format','{{.Status}}'],30000);
  evidence.staging={
    status:ps.success&&ps.stdout.trim()?'PASS':'FAIL',
    containerName:container,
    hostPort:port,
    containerPort,
    image:tag,
    command:r,
    statusOutput:ps.stdout.trim()
  };

  if(evidence.staging.status!=='PASS'){
    const logs=run('docker',['logs',container],30000);
    evidence.staging.logs=logs;
    setBlocked(evidence.health,'Container is not running.');
    return;
  }

  const candidates=[process.env.NEXUS_HEALTH_PATH,'/health','/healthz','/api/health','/'].filter(Boolean);
  for(const path of [...new Set(candidates)]){
    const url=`http://127.0.0.1:${port}${path}`;
    const h=run('curl.exe',['-sS','-o',`${tmpdir()}/nexus-pass5-health.txt`,'-w','%{http_code}',url],20000);
    const code=Number(h.stdout.trim());
    if(h.success && code>=200 && code<400){
      evidence.health={status:'PASS',url,endpoint:path,http_status:code,command:h};
      return;
    }
  }

  const logs=run('docker',['logs',container],30000);
  evidence.health={
    status:'FAIL',
    reason:'No health endpoint returned HTTP 2xx/3xx.',
    container:container,
    command:logs,
    logs
  };
}
function smoke(){
  if(evidence.staging.status!=='PASS'||evidence.health.status!=='PASS')
    return setBlocked(evidence.smoke,'Real staging/health did not pass.');

  const spec=existsSync(join(root,'tests','smoke','nexus-staging.spec.ts'))
    ? 'tests/smoke/nexus-staging.spec.ts' : null;
  if(!spec)
    return setBlocked(evidence.smoke,'Existing staging smoke spec not found.');

  if(!evidence.capabilities.playwright)
    return setBlocked(evidence.smoke,'Playwright CLI is unavailable.');

  // The actual smoke run is the browser capability proof.
  const r=run(NPX,['playwright','test',spec],600000);
  evidence.capabilities.chromium=r.success;
  evidence.smoke={
    status:r.success?'PASS':'FAIL',
    browser_proof:r.success?'Real Playwright browser execution succeeded.':'Real Playwright browser execution failed.',
    command:r
  };
}
function gate(){const a=['build','sbom','docker','image','container_security','image_sbom','staging','health','smoke'].map(k=>evidence[k].status);evidence.quality_gate={status:a.includes('BLOCKED')?'BLOCKED':a.includes('FAIL')?'FAIL':'PASS',checks:a};}
function rollback(){setBlocked(evidence.rollback,'No safe real two-version rollback fixture was executed.');setBlocked(evidence.rollback_verification,'Rollback was not executed; no simulation is allowed.');}
function regression(){const t=run(NPM,['run','typecheck'],300000),b=run(NPM,['run','build'],300000),p1=existsSync(join(root,'scripts','verify-phase1.mjs'))?run(NODE,['scripts/verify-phase1.mjs'],300000):null,r3=existsSync(join(root,'scripts','verify-phase3-rollback.ps1'))?run(WIN?'powershell.exe':'powershell',['-ExecutionPolicy','Bypass','-File','scripts/verify-phase3-rollback.ps1'],300000):null;evidence.regression={status:t.success&&b.success?'PASS':'FAIL',typecheck:t,build:b,verifyPhase1:p1,verifyPhase3Rollback:r3};}
function cleanup(){if(evidence.staging?.containerName)run('docker',['rm','-f',container],30000);if(evidence.docker.status==='PASS')run('docker',['rmi',tag],30000);}
async function main(){console.log('========================================\nNEXUS PHASE 3 — PASS 5 REAL VERIFICATION\n========================================');probe();console.log('\nCAPABILITIES');for(const [k,v] of Object.entries(evidence.capabilities))console.log(`${k}: ${v?'PASS':'FAIL'}`);build();sbom();dockerBuild();security();imageSbom();await stagingHealth();smoke();gate();rollback();regression();console.log('\nRUNTIME');for(const k of ['sbom','docker','image','container_security','image_sbom','staging','health','smoke','quality_gate','rollback','rollback_verification'])console.log(`${k}: ${evidence[k].status}`);console.log(`REGRESSION: ${evidence.regression.status}`);const required=[
  'build','sbom','docker','image','container_security','image_sbom',
  'staging','health','smoke','quality_gate','rollback','rollback_verification','regression'
].map(k=>evidence[k]?.status);
const final=required.includes('FAIL')?'FAIL':required.includes('BLOCKED')?'BLOCKED':'PASS';evidence.final_status=final;evidence.finished_at=new Date().toISOString();writeFileSync(join(root,'pass5-evidence.json'),JSON.stringify(evidence,null,2));console.log(`\n========================================\nFINAL STATUS: ${final}\n========================================\nEvidence: pass5-evidence.json`);cleanup();process.exitCode=final==='PASS'?0:1;}
main().catch(e=>{evidence.final_status='FAIL';evidence.fatal_error=String(e.stack||e);writeFileSync(join(root,'pass5-evidence.json'),JSON.stringify(evidence,null,2));console.error(e);process.exitCode=1;});
