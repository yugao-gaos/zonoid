#!/usr/bin/env node
// Static regression for graph.html's onboarding-empty state. The dashboard is a
// single HTML file, so this verifies the old banner path stays removed and the
// auto-start landing hooks stay present.
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
const functionBody = (name) => {
  const match = html.match(new RegExp(`function ${name}\\(s\\) \\{([\\s\\S]*?)\\n\\}`));
  return match ? match[1] : '';
};
const drainedBody = functionBody('onboardStatusDrained');
const completeBody = functionBody('onboardStatusComplete');

ok('landing root exists', html.includes('id="onboard-landing"'));
ok('pending mode hides dashboard shell', /body\.onboarding-pending\s+header[\s\S]*body\.onboarding-pending\s+#statusDock[\s\S]*body\.onboarding-pending\s+\.wrap/.test(html));
ok('pending mode shows landing', /body\.onboarding-pending\s+#onboard-landing\s*\{\s*display:\s*flex/.test(html));
ok('landing uses graph cloud surface', html.includes('id="onboardCloudSvg"') && html.includes('renderOnboardCloud') && html.includes('buildOnboardCloudState'));
ok('old step cards are removed', !html.includes('data-onboard-step=') && !html.includes('Review &amp; Inject'));
ok('old progress bar is removed', !html.includes('id="onboardProgressFill"') && !html.includes('ol-progress-track'));
ok('processed kept injected status is present', html.includes('id="onboardProgressStat"') && html.includes('kept ${Math.max') && html.includes('injected ${Math.max'));
ok('kept note labels prefer status titles', html.includes('const keptNotes = Array.isArray(s.keptNotes)') && html.includes('noteLabel(i, `kept note ${i + 1}`)'));
ok('missing ingest notes auto-start learning', /showOnboardLanding\(\);\s*renderOnboardCloud[\s\S]*if \(workspace\) ensureOnboardLearning\(workspace\);/.test(html));
ok('auto-start calls enqueue endpoint', html.includes("dfetch('/onboard/enqueue'"));
ok('auto-start calls drain endpoint', html.includes("dfetch('/onboard/drain-queue'"));
ok('auto-start requests live auto inject', html.includes('autoInject: true') && html.includes('liveInject: true'));
ok('stored outDir resumes without enqueue guard', html.includes("const storedOutDir = localStorage.getItem(onboardStoreKey('outdir')) || ''") && html.includes('if (!outDir)'));
ok('completed latch exits reload before note-search restart', /if \(workspace && !storedOutDir && localStorage\.getItem\(onboardCompletedKey\(\)\) === '1'\) \{[\s\S]*completeOnboardLearning\(\);[\s\S]*return;[\s\S]*\}/.test(html));
ok('default onboarding output uses ignored .zonoid state', /function defaultOnboardOutDir\(workspace\) \{[\s\S]*'\.zonoid'[\s\S]*'onboard'[\s\S]*\}/.test(html));
ok('legacy onboarding output candidates are still checked', /function legacyOnboardOutDirs\(workspace\) \{[\s\S]*'\.graph'[\s\S]*'bench'[\s\S]*'onboard'[\s\S]*\}/.test(html));
ok('missing outDir checks default and legacy queues before enqueue', /for \(const candidateOutDir of candidateOnboardOutDirs\(workspace\)\) \{[\s\S]*\/onboard\/drain-queue\?repo=[\s\S]*candidateOutDir[\s\S]*onboardStatusComplete\(st\.status\)[\s\S]*localStorage\.setItem\(onboardStoreKey\('outdir'\), candidateOutDir\)[\s\S]*No existing default\/legacy queue/.test(html));
ok('stored completed job exits onboarding before note search restart', /if \(st\.ok && st\.status && onboardStatusComplete\(st\.status\)\) \{[\s\S]*completeOnboardLearning\(\);[\s\S]*return;[\s\S]*\}/.test(html));
ok('stored incomplete job keeps landing despite early ingest notes', /if \(st\.ok && st\.status\) \{[\s\S]*showOnboardLanding\(\);[\s\S]*updateOnboardFromStatus\(st\.status\)/.test(html));
ok('stored incomplete queue restarts drain via POST resume path', /const shouldResumeDrain = onboardStatusNeedsResume\(st\.status\);[\s\S]*landing\.dataset\.draining = shouldResumeDrain \? '' : '1';[\s\S]*if \(shouldResumeDrain\) ensureOnboardLearning\(workspace\);\s*else pollOnboardLearning\(\);/.test(html));
ok('resume predicate covers incomplete recovered inactive statuses', /function onboardStatusNeedsResume\(s\) \{[\s\S]*s\.done !== true[\s\S]*s\.recovered[\s\S]*s\.active === false[\s\S]*!s\.injected/.test(html));
ok('shared cloud renderer is reused for onboarding', html.includes("renderCloud(buildOnboardCloudState(status), { mode: 'onboard'"));
ok('manual review inject action hidden from default landing', !html.includes('id="onboardInjectBtn"') && !html.includes('Inject reviewed notes'));
ok('completed drained auto-inject queue can finish with injected zero', /function onboardStatusDrained\(s\) \{[\s\S]*remaining === 0 && inflight === 0 && Math\.max\(processed, visualProcessed\) >= total[\s\S]*function onboardStatusNeedsResume/.test(html) && /function onboardStatusComplete\(s\) \{[\s\S]*onboardStatusDrained\(s\)/.test(html));
ok('drained predicate does not require done or inactive status', drainedBody && !/\bs\.done\b|\bs\.active\b/.test(drainedBody) && drainedBody.includes('if (total <= 0) return false') && drainedBody.includes('remaining === 0 && inflight === 0') && drainedBody.includes('Math.max(processed, visualProcessed) >= total'));
ok('done-false full-drain status completes through drained predicate', completeBody.includes('onboardStatusDrained(s) ||') && html.includes('if (!s.done && !drained)') && /if \(drained\) \{[\s\S]*setTimeout\(completeOnboardLearning, 1000\)/.test(html));
ok('drained no-injection status opens dashboard with clear copy', html.includes('no reviewed notes were injected. Opening dashboard...') && /if \(drained\) \{[\s\S]*setTimeout\(completeOnboardLearning, 1000\)/.test(html));
ok('completion persists reload latch and clears pending outDir', /function completeOnboardLearning\(\) \{[\s\S]*localStorage\.setItem\(onboardCompletedKey\(\), '1'\);[\s\S]*localStorage\.removeItem\(onboardStoreKey\('outdir'\)\)/.test(html));
ok('new enqueue clears completed latch before mining', /if \(!outDir\) \{[\s\S]*localStorage\.removeItem\(onboardCompletedKey\(\)\);[\s\S]*dfetch\('\/onboard\/enqueue'/.test(html));
ok('cloud uses shared projected 3d point layout', html.includes('const usePointCloud=true') && html.includes('const projectCloudNode=(n,elapsed=0)=>') && html.includes('n.vz=Math.max(-1,Math.min(1,rz))') && html.includes('projectedDepth(n)'));
ok('dashboard cloud also bypasses force simulation collapse', /if\(usePointCloud\)\{[\s\S]*if\(getSim\(\)\) getSim\(\)\.stop\(\);[\s\S]*placeCloud\(\);[\s\S]*setSig\(sig\);[\s\S]*\} else if\(q\)/.test(html));
ok('svg fallback dashboard point cloud does not run a continuous RAF loop', html.includes('const animatePointCloud=isOnboard') && html.includes('const elapsed=animatePointCloud?Date.now()/1000:0') && html.includes('if(usePointCloud&&!animatePointCloud&&cloudRaf)') && html.includes('if(usePointCloud&&animatePointCloud)'));
ok('cloud prefers shared three.js point cloud renderer', html.includes('Copyright 2010-2023 Three.js Authors') && html.includes('function renderCloudThree(ctx)') && html.includes('renderCloudThree({'));
ok('onboarding and dashboard differ by renderer profile parameters', html.includes('const cloudProfile=isOnboard') && html.includes("mode:'onboard'") && html.includes("mode:'dashboard'") && html.includes('profile:cloudProfile'));
ok('three point cloud uses readable shared color palette', html.includes('const CLOUD_NODE_COLOR=') && html.includes('function cloudDisplayTriplet') && html.includes('cloudNodeColorOf(n,byId)') && html.includes('ctx.profile.edgeColor') && html.includes('ctx.profile.contextEdgeColor'));
ok('three point cloud disables scene fog on visible marks', html.includes('renderer.outputEncoding=THREE.sRGBEncoding') && html.includes('depthWrite:true, fog:false') && html.includes('depthWrite:false, fog:false'));
ok('dashboard search view falls back to related edges during prune and final', html.includes('const fallbackFinalNodeKeys=new Set()') && html.includes('const fallbackFinalEdgeKeys=new Set()') && html.includes("searchPhase==='prune'||searchPhase==='final'") && html.includes('searchEdgeFallback(l)'));
ok('dashboard search highlights nodes with compact core only', html.includes('function cloudSearchTriplet') && html.includes('const hoverEmphasis=n===st.hoverNode?0.95:0') && html.includes('const emphasis=Math.max(ctx.searchHighlight?ctx.searchHighlight(n):0,hoverEmphasis)') && html.includes('THREE.AdditiveBlending') && !html.includes('haloEntries') && !html.includes('haloMesh'));
ok('three point cloud keeps only highlighted node balls self-lit', html.includes('const coreEntries=[]') && html.includes('if(emphasis>0){') && html.includes('baseRadius*(0.86+emphasis*.3)') && html.includes('color:0x8bdcff') && html.includes('coreMesh.renderOrder=4') && html.includes('if(searchNodeActive(n)) return Math.max(0.76,o)'));
ok('dashboard search fallback keeps link comparator in scope', html.includes("let linkCmp=(a,b)=>String((a&&a.key)||'').localeCompare(String((b&&b.key)||''))") && html.includes('linkCmp=(a,b)=>{') && html.includes('activationEdgeMeta.values()].sort(linkCmp)'));
ok('dashboard point cloud caps default labels through the shared profile', html.includes('maxLabels:narrowCloud?8:24') && html.includes('const dashboardLabelIds = new Set()') && html.includes('dashboardLabelIds.has(n.id)'));
ok('dashboard point cloud dedupes repeated label text', html.includes('const seenDashboardLabels = new Set()') && html.includes('seenText.has(textKey)'));
ok('dashboard point cloud keeps labels inside narrow canvas bounds', html.includes('const narrowCloud=W<640') && html.includes('const half=Math.min((item.el.offsetWidth||120)/2') && html.includes('Math.min(st.size.w-half-6,rawX)'));
ok('three renderer shares point layout with svg fallback', html.includes('const cloudPoint3D=(n,elapsed=0)=>') && html.includes('const p=cloudPoint3D(n,elapsed)') && html.includes('cloudPoint3D(n,0)'));
ok('dashboard search fit uses projected coordinates', html.includes('Number.isFinite(n.vx)?n.vx:n.x') && html.includes('Number.isFinite(n.vy)?n.vy:n.y'));
ok('onboarding point cloud limits labels to sparse foreground', html.includes('const onboardLimit = Math.min(3, Math.max(1, Math.ceil(simNodes.length / 32)))') && html.includes('projectedDepth(b) - projectedDepth(a)'));
ok('onboarding cloud limits foreground labels', html.includes('const onboardLabelIds = new Set()') && html.includes('isOnboard?onboardLabelIds.has(n.id)'));
ok('onboarding labels move full titles to hover and title text', html.includes("[n.t.label,n.t.description].filter(Boolean).join('\\n')") && /if\(isOnboard\)\{[\s\S]*on\('mouseenter'[\s\S]*truncate\(n\.t\.label,18\)/.test(html));

ok('old banner root removed', !html.includes('onboard-banner'));
ok('manual start button removed', !html.includes('onboardStartBtn') && !html.includes('Start learning'));
ok('dismiss flow removed', !html.includes('dismissOnboardBanner') && !html.includes('onboard_dismissed_') && !html.includes('Dismiss'));
ok('stale CLI prompt removed', !html.includes('npx @zonoid/cli onboard'));

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
