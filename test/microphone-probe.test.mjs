import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(scenario) {
  const output = execFileSync('lua', ['test/fixtures/microphone-harness.lua', scenario,
    'device-probe/microphone-test.lua'], { cwd: root, encoding: 'utf8' }).split('\n');
  return { report: JSON.parse(output[0]), commands: output[1].split('|'), watchdog: output.slice(2).join('\n') };
}

test('unknown firmware and an unarmed independent stop task cannot start capture', () => {
  for (const scenario of ['wrong-firmware', 'no-watchdog', 'old-marker']) {
    const { report, commands } = run(scenario);
    assert.equal(commands.some(c => c.startsWith('AT AT^MIC_ENABLE=')), false);
    assert.equal(report.results.microphone.attempted, false);
    assert.equal(report.results.microphone.captureFileProduced, false);
    assert.ok(report.results.microphone.error);
  }
});

test('the one-shot capture arms an independent stop first and transfers a bounded non-silent sample', () => {
  const { report, commands, watchdog } = run('reload');
  const info = report.results.microphone;
  const enable = commands.findIndex(c => c.startsWith('AT AT^MIC_ENABLE='));
  assert.ok(commands.findIndex(c => c.startsWith('sh ')) < enable);
  assert.ok(commands.indexOf('AT AT^MIC_DISABLE=') > enable);
  assert.equal(commands.filter(c => c.startsWith('AT AT^MIC_ENABLE=')).length, 1);
  assert.match(watchdog, /sleep 3\nAT AT\^MIC_DISABLE=/);
  assert.equal(info.rawBytesObserved, 96000);
  assert.equal(info.stopEnqueued, true);
  assert.equal(info.samples, 8000);
  const audio = Buffer.from(info.audioBase64, 'base64');
  assert.equal(audio.length, 8000);
  assert.ok(new Set(audio).size > 1);
  assert.equal(info.sourcePeak, 1000);
  assert.equal(info.sourceRms, 1000);
  assert.ok(JSON.stringify(report).length < 30000);
});

test('an exception after starting capture still submits STOP', () => {
  const { report, commands } = run('capture-error');
  assert.equal(report.results.microphone.attempted, true);
  assert.match(report.results.microphone.error, /injected wait error/);
  assert.equal(report.results.microphone.stopEnqueued, true);
  assert.ok(commands.includes('AT AT^MIC_DISABLE='));
});
