const crypto = require('node:crypto');
const PACKAGE = 'com.veamstudios.siteauditpro';
const REPOSITORY = 'VeamStudios/SiteAuditPro-AndroidNew';
const TRACK = 'production';
const ROOT = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const LIFECYCLE = 'RELEASE_LIFECYCLE_STATE_';
const WAITING = ['DRAFT', 'NOT_SENT_FOR_REVIEW', 'IN_REVIEW', 'APPROVED_NOT_PUBLISHED', 'NOT_APPROVED'];
const buildCode = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));

/** This client deliberately exposes no upload, track update or commit method.
 * A dedicated identity is mandatory: inserts invalidate that identity's old edit. */
class GooglePlayMonitor {
  constructor(credentials, {fetcher = fetch, expectedEmail, uploaderEmail} = {}) {
    if (credentials?.type !== 'service_account' || !credentials.private_key || !credentials.client_email ||
        !expectedEmail || credentials.client_email !== expectedEmail || !uploaderEmail || expectedEmail === uploaderEmail) {
      throw new Error('Configure a dedicated PLAY_MONITOR_SERVICE_ACCOUNT_JSON, PLAY_MONITOR_SERVICE_ACCOUNT_EMAIL and PLAY_UPLOADER_SERVICE_ACCOUNT_EMAIL; monitor and uploader must differ');
    }
    this.credentials = credentials; this.fetcher = fetcher;
  }
  async token() {
    const now = Math.floor(Date.now() / 1000), encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const input = `${encode({alg:'RS256',typ:'JWT'})}.${encode({iss:this.credentials.client_email,scope:'https://www.googleapis.com/auth/androidpublisher',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
    const assertion = `${input}.${crypto.sign('RSA-SHA256',Buffer.from(input),this.credentials.private_key).toString('base64url')}`;
    const response = await this.fetcher('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error(`Play monitor authentication failed (${response.status})`);
    const result = await response.json();
    if (!result.access_token) throw new Error('Play monitor token missing');
    return result.access_token;
  }
  async snapshot() {
    const token = await this.token();
    const call = async (path, method = 'GET') => {
      const response = await this.fetcher(`${ROOT}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error(`Play monitor ${method} failed (${response.status}); no availability inferred`);
      return response.status===204?{}:response.json();
    };
    const before = await call('/tracks/production/releases');
    const edit = await call('/edits','POST');
    if (typeof edit.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(edit.id)) throw new Error('Play returned an invalid temporary edit identity');
    let track;
    try { track = await call(`/edits/${edit.id}/tracks/production`); }
    finally { await call(`/edits/${edit.id}`,'DELETE'); }
    const after = await call('/tracks/production/releases');
    // A promotion during the two reads cannot be mixed into a fabricated observation.
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Play lifecycle changed during inspection; retry a fresh snapshot');
    return {packageName:PACKAGE,track:TRACK,lifecycle:after,rollout:track,checkedAt:new Date().toISOString(),evidence:`${ROOT}/tracks/production/releases`,rolloutEvidence:`${ROOT}/edits/${edit.id}/tracks/production`};
  }
}

function snapshotBuilds(snapshot) {
  if (snapshot.packageName!==PACKAGE || snapshot.track!==TRACK || snapshot.rollout?.track!==TRACK ||
      !Array.isArray(snapshot.lifecycle?.releases) || !Array.isArray(snapshot.rollout?.releases) ||
      !Number.isFinite(Date.parse(snapshot.checkedAt))) throw new Error('Malformed or wrong-package production snapshot');
  const builds = new Set();
  for (const release of snapshot.lifecycle.releases) {
    if (release.track!==TRACK || !Array.isArray(release.activeArtifacts) || !release.activeArtifacts.length) throw new Error('Malformed lifecycle release');
    for (const artifact of release.activeArtifacts) {
      if (!buildCode(artifact.versionCode)) throw new Error('Invalid Play versionCode');
      builds.add(String(artifact.versionCode));
    }
  }
  return [...builds];
}

function observePlay(identity, snapshot) {
  snapshotBuilds(snapshot);
  if (identity.repository!==REPOSITORY || identity.target!=='android-consumer' || !buildCode(identity.build) || !/^[a-f0-9]{40}$/.test(identity.commit)) throw new Error('Unsupported Android release identity');
  const lifecycle = snapshot.lifecycle.releases.filter(r=>r.activeArtifacts.some(a=>String(a.versionCode)===identity.build));
  const rollout = snapshot.rollout.releases.filter(r=>Array.isArray(r.versionCodes)&&r.versionCodes.map(String).includes(identity.build));
  if (lifecycle.length!==1 || rollout.length!==1) throw new Error('Missing or ambiguous exact-build Play evidence');
  const state = lifecycle[0].releaseLifecycleState, status = rollout[0].status;
  if (![...WAITING,'PUBLISHED'].map(x=>LIFECYCLE+x).includes(state) || !['draft','inProgress','halted','completed'].includes(status)) throw new Error('Unknown Play lifecycle or rollout status');
  if (rollout[0].countryTargeting || (status==='completed' && rollout[0].userFraction!==undefined && rollout[0].userFraction!==1)) throw new Error('Production availability is restricted or inconsistent');
  if (status==='inProgress' && !(rollout[0].userFraction>0 && rollout[0].userFraction<1)) throw new Error('Invalid staged rollout fraction');
  let phase='uploaded';
  if (state===LIFECYCLE+'PUBLISHED') {
    if (status==='draft') throw new Error('Published lifecycle contradicts draft rollout');
    phase=status==='completed'?'live':status==='inProgress'?'rollout':'halted';
  }
  const verification={kind:'google-play',packageName:PACKAGE,track:TRACK,versionCode:identity.build,build:identity.build,repository:identity.repository,commit:identity.commit,lifecycle:state,rolloutStatus:status,checkedAt:snapshot.checkedAt,evidence:snapshot.evidence,rolloutEvidence:snapshot.rolloutEvidence};
  return {phase,source:snapshot.evidence,releasedAt:snapshot.checkedAt,verification};
}

function validGooglePlay(v,m) {
  return Boolean(v?.kind==='google-play' && m.repository===REPOSITORY && m.target==='android-consumer' &&
    v.repository===m.repository && v.commit===m.commit && buildCode(m.build) && v.build===m.build && v.versionCode===m.build &&
    v.packageName===PACKAGE && v.track===TRACK && v.lifecycle===LIFECYCLE+'PUBLISHED' && v.rolloutStatus==='completed' &&
    Number.isFinite(Date.parse(v.checkedAt)) && v.evidence===`${ROOT}/tracks/production/releases` &&
    typeof v.rolloutEvidence==='string' && v.rolloutEvidence.startsWith(`${ROOT}/edits/`) && /^[-A-Za-z0-9_]+\/tracks\/production$/.test(v.rolloutEvidence.slice(`${ROOT}/edits/`.length)));
}

function resolveBuild(build, tags, resolve) {
  if (!buildCode(build)) throw new Error('versionCode must be a positive integer');
  const matches=tags.filter(tag=>tag.startsWith('internal/')&&tag.endsWith(`-${build}`));
  if (matches.length!==1) throw new Error(`versionCode ${build} needs exactly one internal/*-${build} tag`);
  const match=matches[0].match(/^internal\/(\d+\.\d+\.\d+)-([1-9]\d*)$/);
  if (!match) throw new Error('Production needs a stable marketing version in the exact internal tag');
  const commit=resolve(matches[0]);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Internal tag does not resolve to an exact commit');
  return {repository:REPOSITORY,target:'android-consumer',version:`v${match[1]}`,build:String(build),commit,internalTag:matches[0]};
}
module.exports={GooglePlayMonitor,snapshotBuilds,observePlay,validGooglePlay,resolveBuild,PACKAGE,REPOSITORY,ROOT};
