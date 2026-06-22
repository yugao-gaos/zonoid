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
ok('stored completed job exits onboarding before note search restart', /if \(st\.ok && st\.status && onboardStatusComplete\(st\.status\)\) \{[\s\S]*completeOnboardLearning\(\);[\s\S]*return;[\s\S]*\}/.test(html));
ok('stored incomplete job keeps landing despite early ingest notes', /if \(st\.ok && st\.status\) \{[\s\S]*showOnboardLanding\(\);[\s\S]*updateOnboardFromStatus\(st\.status\)/.test(html));
ok('stored incomplete queue restarts drain via POST resume path', /const shouldResumeDrain = onboardStatusNeedsResume\(st\.status\);[\s\S]*landing\.dataset\.draining = shouldResumeDrain \? '' : '1';[\s\S]*if \(shouldResumeDrain\) ensureOnboardLearning\(workspace\);\s*else pollOnboardLearning\(\);/.test(html));
ok('resume predicate covers incomplete recovered inactive statuses', /function onboardStatusNeedsResume\(s\) \{[\s\S]*s\.done !== true[\s\S]*s\.recovered[\s\S]*s\.active === false[\s\S]*!s\.injected/.test(html));
ok('shared cloud renderer is reused for onboarding', html.includes("renderCloud(buildOnboardCloudState(status), { mode: 'onboard'"));
ok('manual review inject action hidden from default landing', !html.includes('id="onboardInjectBtn"') && !html.includes('Inject reviewed notes'));
ok('completed drained auto-inject queue can finish with injected zero', /function onboardStatusDrained\(s\) \{[\s\S]*remaining === 0 && inflight === 0 && Math\.max\(processed, visualProcessed\) >= total[\s\S]*function onboardStatusNeedsResume/.test(html) && /function onboardStatusComplete\(s\) \{[\s\S]*onboardStatusDrained\(s\)/.test(html));
ok('drained no-injection status opens dashboard with clear copy', html.includes('no reviewed notes were injected. Opening dashboard...') && /if \(drained\) \{[\s\S]*setTimeout\(completeOnboardLearning, 1000\)/.test(html));
ok('onboarding cloud limits foreground labels', html.includes('const onboardLabelIds = new Set()') && html.includes('isOnboard?onboardLabelIds.has(n.id)'));
ok('onboarding labels move full titles to hover and title text', html.includes("[n.t.label,n.t.description].filter(Boolean).join('\\n')") && /if\(isOnboard\)\{[\s\S]*on\('mouseenter'[\s\S]*truncate\(n\.t\.label,18\)/.test(html));

ok('old banner root removed', !html.includes('onboard-banner'));
ok('manual start button removed', !html.includes('onboardStartBtn') && !html.includes('Start learning'));
ok('dismiss flow removed', !html.includes('dismissOnboardBanner') && !html.includes('onboard_dismissed_') && !html.includes('Dismiss'));
ok('stale CLI prompt removed', !html.includes('npx @zonoid/cli onboard'));

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
