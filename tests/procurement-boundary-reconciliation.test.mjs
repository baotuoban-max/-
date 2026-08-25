import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sidepanelSource = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Function not found: ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed function: ${name}`);
}

function makeContext() {
  const context = {String, Number, Array, Object, JSON, Math};
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'afternoonSpecText'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'mergeProcurementPlatformSnapshot'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'classifyCrossPlatformSource'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementSpecQtyTotal'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'buildProcurementPlatformGroupSnapshot'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'reconcileProcurementSourcePlans'), context);
  return context;
}

test('replaces only the current platform branch and preserves other platforms', () => {
  const context = makeContext();
  const result = context.mergeProcurementPlatformSnapshot({
    platform: '淘宝-【7205】\n京东-【7205】\n拼多多-【7205】',
    spec: '淘宝SKU;3\n京东SKU;2\n拼多多旧SKU;5',
    platformSpecs: JSON.stringify({
      '淘宝-【7205】': '淘宝SKU;3',
      '京东-【7205】': '京东SKU;2',
      '拼多多-【7205】': '拼多多旧SKU;5',
    }),
  }, '拼多多-【7205】', '拼多多新A;2\n拼多多新B;1');

  assert.equal(result.unresolved, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.platformSpecs)), {
    '淘宝-【7205】': '淘宝SKU;3',
    '京东-【7205】': '京东SKU;2',
    '拼多多-【7205】': '拼多多新A;2\n拼多多新B;1',
  });
  assert.equal(result.platform, '淘宝-【7205】\n京东-【7205】\n拼多多-【7205】');
  assert.match(result.spec, /淘宝SKU;3/);
  assert.match(result.spec, /京东SKU;2/);
  assert.match(result.spec, /拼多多新A;2/);
  assert.doesNotMatch(result.spec, /拼多多旧SKU/);
});

test('removing one platform branch does not remove other platform demand', () => {
  const context = makeContext();
  const result = context.mergeProcurementPlatformSnapshot({
    platform: '淘宝-【7205】\n京东-【7205】',
    spec: '淘宝SKU;3\n京东SKU;2',
    platformSpecs: JSON.stringify({
      '淘宝-【7205】': '淘宝SKU;3',
      '京东-【7205】': '京东SKU;2',
    }),
  }, '淘宝-【7205】', '');

  assert.deepEqual(JSON.parse(JSON.stringify(result.platformSpecs)), {
    '京东-【7205】': '京东SKU;2',
  });
  assert.equal(result.platform, '京东-【7205】');
  assert.equal(result.spec, '京东SKU;2');
});

test('reconstructs a legacy multi-platform row before replacing one branch', () => {
  const context = makeContext();
  const result = context.mergeProcurementPlatformSnapshot({
    platform: '淘宝-【7205】\n京东-【7205】',
    spec: '淘宝SKU;3\n京东旧SKU;2',
    platformSpecs: '',
  }, '京东-【7205】', '京东新SKU;4', {
    '淘宝-【7205】': '淘宝SKU;3',
    '京东-【7205】': '京东旧SKU;2',
  });

  assert.equal(result.unresolved, false);
  assert.equal(result.platform, '淘宝-【7205】\n京东-【7205】');
  assert.equal(result.spec, '淘宝SKU;3\n京东新SKU;4');
  assert.equal(result.platformSpecs['京东-【7205】'], '京东新SKU;4');
});

test('preserves an incomplete legacy aggregate instead of aborting the current platform sync', () => {
  const context = makeContext();
  const result = context.mergeProcurementPlatformSnapshot({
    platform: '淘宝-【7205】\n快手小店-【7205】\n微信小店-【7205】',
    spec: '多用炒锅蒸盘33cm;266',
    platformSpecs: '',
  }, '淘宝-【7205】', '多用炒锅蒸盘33cm;10', {
    '微信小店-【7205】': '多用炒锅蒸盘33cm;215',
  });

  assert.equal(result.unresolved, false);
  assert.equal(result.legacyPreserved, true);
  assert.equal(result.platform, '淘宝-【7205】\n快手小店-【7205】\n微信小店-【7205】');
  assert.equal(result.platformSpecs.__legacy__, '多用炒锅蒸盘33cm;266');
  assert.equal(result.platformSpecs['淘宝-【7205】'], '多用炒锅蒸盘33cm;10');
  assert.equal(result.spec, '多用炒锅蒸盘33cm;266');
});

test('ignores the opaque legacy branch when checking platform-spec completeness', () => {
  const context = makeContext();
  const result = context.classifyCrossPlatformSource(
    '淘宝-【7205】\n微信小店-【7205】',
    JSON.stringify({
      __legacy__: '历史汇总规格;266',
      '淘宝-【7205】': '淘宝规格;10',
      '微信小店-【7205】': '微信规格;5',
    }),
  );

  assert.equal(result.safelySplittable, true);
  assert.equal(result.platformSpecs.__legacy__, '历史汇总规格;266');
});

test('drops the opaque legacy branch once every platform branch is available', () => {
  const context = makeContext();
  const result = context.mergeProcurementPlatformSnapshot({
    platform: '淘宝-【7205】\n京东-【7205】',
    spec: '旧汇总;266',
    platformSpecs: JSON.stringify({
      __legacy__: '旧汇总;266',
      '淘宝-【7205】': '淘宝规格;10',
    }),
  }, '京东-【7205】', '京东规格;5');

  assert.equal(result.unresolved, false);
  assert.equal(result.legacyPreserved, false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.platformSpecs, '__legacy__'), false);
  assert.equal(result.spec, '淘宝规格;10\n京东规格;5');
});

test('reconciles every source plan into a unique procurement group', () => {
  const context = makeContext();
  const result = context.reconcileProcurementSourcePlans([
    {sourceId: 'source-a', targetId: 'group-1', qty: 3},
    {sourceId: 'source-b', targetId: 'group-1', qty: 2},
    {sourceId: 'source-c', targetId: 'group-2', qty: 4},
  ]);

  assert.equal(result.sourceCount, 3);
  assert.equal(result.mappedCount, 3);
  assert.equal(result.groupCount, 2);
  assert.equal(result.coalescedCount, 1);
  assert.equal(result.unmappedSourceIds.length, 0);
  assert.equal(result.qtyTotal, 9);
});

test('builds one new procurement group from multiple platform branches', () => {
  const context = makeContext();
  const result = context.buildProcurementPlatformGroupSnapshot({
    '淘宝-【7205】': '淘宝SKU;3',
    '京东-【7205】': '京东SKU;2',
  });

  assert.equal(result.platform, '淘宝-【7205】\n京东-【7205】');
  assert.equal(result.spec, '淘宝SKU;3\n京东SKU;2');
  assert.equal(result.qty, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(result.platformSpecs)), {
    '淘宝-【7205】': '淘宝SKU;3',
    '京东-【7205】': '京东SKU;2',
  });
});

test('blocks formal writes when a source plan has no procurement group', () => {
  const context = makeContext();
  const result = context.reconcileProcurementSourcePlans([
    {sourceId: 'source-a', targetId: 'group-1', qty: 3},
    {sourceId: 'source-b', targetId: '', qty: 2},
  ]);

  assert.equal(result.valid, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.unmappedSourceIds)), ['source-b']);
});

test('ensures the formal table has a platform-spec branch field', async () => {
  const calls = [];
  const context = {
    Promise,
    JSON,
    getToken: () => Promise.resolve('token'),
    feishuProxy: (url, method, headers, body) => {
      calls.push({url, method, headers, body});
      return Promise.resolve({code: 0, data: {field: {field_id: 'field-platform-specs'}}});
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'ensureProcurementPlatformSpecsField'), context);

  const field = await context.ensureProcurementPlatformSpecsField('app-token', 'proc-table', {
    '平台规格明细': {id: 'already-there', type: 1, name: '平台规格明细'},
  });
  assert.equal(field.name, '平台规格明细');
  assert.equal(calls.length, 0);

  const created = await context.ensureProcurementPlatformSpecsField('app-token', 'proc-table', {});
  assert.equal(created.name, '平台规格明细');
  assert.equal(created.id, 'field-platform-specs');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), {field_name: '平台规格明细', type: 1});
});

test('formal reconciliation searches all platform candidates before scoping writes', () => {
  const syncStart = sidepanelSource.indexOf('function syncToProcurement(');
  const syncEnd = sidepanelSource.indexOf('\n}\n\n//', syncStart);
  const syncSource = sidepanelSource.slice(syncStart, syncEnd > syncStart ? syncEnd : undefined);
  // 稳定版等价实现：matchRecord 4 参（无 allowFuzzy 参数），调用后显式拒绝 FUZZY 模糊匹配
  assert.match(
    syncSource,
    /matchRecord\(\s*src\.pid,\s*src\.title,\s*procLookup,\s*src\.platform\s*\|\|\s*''\s*\)/,
  );
  assert.match(
    syncSource,
    /matchRecord\(\s*src\.pid,\s*src\.title,\s*procLookup,\s*plat\s*\)/,
  );
  // 模糊匹配必须被拒绝（不能靠模糊标题覆盖旧记录）
  assert.match(syncSource, /if \(matchType === 'FUZZY' \|\| !matched\)/);
});

test('legacy formal rows rebuild platform branches from the target group identity', () => {
  const syncStart = sidepanelSource.indexOf('function syncToProcurement(');
  const syncEnd = sidepanelSource.indexOf('\n}\n\n//', syncStart);
  const syncSource = sidepanelSource.slice(syncStart, syncEnd > syncStart ? syncEnd : undefined);
  // 稳定版等价实现：跨平台拆分时按平台取 pSpecs，缺失回退到整条规格
  assert.match(syncSource, /var platSpec = pSpecs\[plat\] \|\| ''/);
  assert.match(syncSource, /platSpec \|\| src\.spec/);
});

test('schema sync detects existing fields before creating platform-spec metadata', () => {
  const syncStart = sidepanelSource.indexOf('function syncToProcurement(');
  const syncEnd = sidepanelSource.indexOf('\n}\n\n//', syncStart);
  const syncSource = sidepanelSource.slice(syncStart, syncEnd > syncStart ? syncEnd : undefined);
  // 稳定版等价实现：先 detectTableFields 检测采购表字段，再解析平台规格明细字段
  const detectIndex = syncSource.indexOf('detectTableFields(');
  const pspecIndex = syncSource.indexOf('平台规格明细');
  assert.ok(detectIndex >= 0);
  assert.ok(pspecIndex > detectIndex);
});
