#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sw = require('../lib/schedule-wakeup');
let pass = 0, fail = 0;
const ok = (l,c)=>{if(c){console.log('PASS  '+l);pass++;}else{console.log('FAIL  '+l);fail++;}};
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wake-'));
const SCRIPT = path.resolve(__dirname, '..', 'adapters', 'common', 'schedule-wakeup.sh');
const prevData = process.env.ORCH_DATA; process.env.ORCH_DATA = SANDBOX;
function runSh(args){return spawnSync('bash',[SCRIPT,...args],{encoding:'utf8',env:{...process.env,ORCH_DATA:SANDBOX}});}
try{
ok('resolveWakeDir', sw.resolveWakeDir()===path.join(SANDBOX,'wake'));
ok('sessionSlug', sw.sessionSlug('sess/a')==='sess_a');
const arm=sw.armWakeup({session:'test-sess',delaySeconds:1,reason:'idle',prompt:'wake'});
ok('arm ok', arm.ok&&typeof arm.pid==='number');
ok('pidfile', fs.existsSync(sw.pidFile('test-sess')));
const rearm=sw.armWakeup({session:'test-sess',delaySeconds:2,reason:'re',prompt:'again'});
ok('re-arm ok', rearm.ok&&rearm.pid!==arm.pid);
const cancel=sw.cancelWakeup('test-sess');
ok('cancel ok', cancel.ok&&cancel.canceled);
ok('pidfile gone', !fs.existsSync(sw.pidFile('test-sess')));
ok('noop cancel', sw.cancelWakeup('missing').canceled===false);
ok('arm needs session', sw.armWakeup({delaySeconds:1}).ok===false);
const shArm=runSh(['arm','sh-sess','1','r','p']); ok('sh arm', shArm.status===0&&JSON.parse(shArm.stdout).ok);
const shCancel=runSh(['cancel','sh-sess']); ok('sh cancel', shCancel.status===0&&JSON.parse(shCancel.stdout).canceled);
const claude=require('../lib/adapters/claude');
ok('claude native', claude.scheduler.armWakeup().method==='native');
ok('claude noop', claude.scheduler.cancelWakeup().noop===true);
const harness=require('../lib/harness');
ok('harness export', typeof harness.scheduleWakeup.armWakeup==='function');
}finally{if(prevData===undefined)delete process.env.ORCH_DATA;else process.env.ORCH_DATA=prevData;fs.rmSync(SANDBOX,{recursive:true,force:true});}
console.log('-----');console.log(pass+' passed, '+fail+' failed');process.exit(fail?1:0);
