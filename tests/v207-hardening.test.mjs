import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const automation = fs.readFileSync(new URL('../automation.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const sidepanel = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

const uuidStart = automation.indexOf('function autoIdempotencyUuid(seed)');
const uuidEnd = automation.indexOf('\n  function autoCreateQueueRecords', uuidStart);
assert.ok(uuidStart >= 0 && uuidEnd > uuidStart, 'idempotency UUID helper must exist');

const sandbox = {};
vm.runInNewContext(
  automation.slice(uuidStart, uuidEnd) + '\nthis.makeUuid = autoIdempotencyUuid;',
  sandbox
);

const seed = 'tblLpoliA366EPmS:2026-07-31:13-unique-commands';
const first = sandbox.makeUuid(seed);
const second = sandbox.makeUuid(seed);
const other = sandbox.makeUuid(seed + ':other');

assert.equal(first, second, 'same batch must reuse the same idempotency token');
assert.notEqual(first, other, 'different batches must receive different tokens');
assert.match(
  first,
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  'Feishu client_token must be a UUIDv4'
);

assert.match(background, /var _automationLeaseOperation = Promise\.resolve\(\)/);
assert.match(background, /persisted && persisted\.expiresAt > nowLease/);
assert.match(background, /sendResponse\(\{ok:false, busy:true, owner:/);
assert.match(sidepanel, /no_dgj_tab:/);
assert.match(automation, /今日自动化任务存在重复唯一键，已停止执行/);
assert.match(automation, /'附件状态':attachmentFailed \? '待补图片' : '已完成'/);

console.log('v207-hardening.test: PASS');

// v20.7.8: Verify stale source deletion preserves "未打单" morning estimates
assert.match(sidepanel, /v20.12.58: Built-in status protection/);
assert.match(sidepanel, /\[安全\] 保留.*条未打单上午预估/);
assert.match(sidepanel, /statusLookup\[rec\.record_id\] = sv\(rf\[F_STATUS\]\)/);
