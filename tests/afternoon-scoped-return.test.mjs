import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const pluginRoot = new URL('..', import.meta.url);
const sidepanelSource = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');
const automationSource = fs.readFileSync(new URL('../automation.js', import.meta.url), 'utf8');

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

function makeAfternoonContext(syncResult = {updated: 18, created: 1}) {
  const calls = {sync: [], verify: [], cleanup: 0, tracker: 0, notices: 0, ended: []};
  const context = {
    Promise,
    Date,
    console,
    L: () => {},
    _lastReturnWorkflowResult: null,
    syncToProcurement: (options) => {
      calls.sync.push(options);
      return Promise.resolve(syncResult);
    },
    verifyUpload: (...args) => {
      calls.verify.push(args);
      return Promise.resolve({ok: true});
    },
    afternoonWorkflowCanCleanup: () => true,
    finalizeAfternoonSourceCleanup: () => {
      calls.cleanup += 1;
      return Promise.resolve({ok: true, deleted: 0});
    },
    trackerRecordAfternoon: () => {
      calls.tracker += 1;
      return Promise.resolve({ok: true});
    },
    endTask: (...args) => calls.ended.push(args),
    notifySuccess: () => {
      calls.notices += 1;
      return Promise.resolve({ok: true});
    },
    chrome: {
      storage: {local: {set: (_value, callback) => callback()}},
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'runAfternoonPostReturn'), context);
  return {context, calls};
}

function makeManualNotificationContext(automationReturn = false) {
  const calls = {notices: 0, noticeArgs: []};
  const context = {
    Promise,
    String,
    window: {
      _dgjAutomationReturn: automationReturn,
      dgjFormatAfternoonSummary: () => 'summary',
      dgjFormatAfternoonCardElements: () => [{tag: 'div', text: {content: 'card'}}],
      dgjNotifyCompletionSafely: (...args) => {
        calls.notices += 1;
        calls.noticeArgs.push(args);
        return Promise.resolve({ok: true});
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'delegateAutomationNotice'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'notifyManualReturnCompletion'), context);
  return {context, calls};
}

function makeMatchContext() {
  const context = {
    String,
    Array,
    norm: (value) => String(value || '').trim().toLowerCase(),
    sv: (value) => String(value || ''),
    extractRecFields: (rec) => {
      const fields = rec.fields || {};
      return {
        title: fields['📡 商品全称'] || '',
        spec: fields['🚧 ❗【时段】产品需求值'] || '',
        platform: fields['平台所属账号'] || fields['平台【文字】'] || '',
      };
    },
    procurementFamilyConflict: () => false,
    procurementModelConflict: () => false,
    coreProductConflict: () => ({conflict: false}),
    jaroWinkler: () => 0.99,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'normTitle'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'canonicalProcurementTitleKey'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementTitleIdentityExact'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementHasSplitTitleMarker'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'chooseProcurementTitleRecord'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementPlatformContains'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'matchRecord'), context);
  return context;
}

function makePostMergeContext() {
  const context = {String, Array, Object};
  vm.createContext(context);
  const familyStart = sidepanelSource.indexOf('var CORE_PRODUCT_FAMILIES = {');
  const familyEnd = sidepanelSource.indexOf('\n};', familyStart) + 3;
  vm.runInContext(sidepanelSource.slice(familyStart, familyEnd), context);
  // V20.29.3: 规格结构化解析器依赖（SPEC_ATTR_WORDS 常量 + 解析函数）
  const attrStart = sidepanelSource.indexOf('var SPEC_ATTR_WORDS');
  if (attrStart >= 0) {
    const attrEnd = sidepanelSource.indexOf(';', attrStart) + 1;
    vm.runInContext(sidepanelSource.slice(attrStart, attrEnd), context);
  }
  vm.runInContext(extractFunction(sidepanelSource, 'procurementSpecQtyTotal'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'extractCoreProductFamilies'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'extractCoreProductNoun'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'specExtractFamilies'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'checkSpecCrossContamination'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'extractSpecLineProductName'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'parseSpecLine'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'parseSpecStructure'), context);
  return context;
}

function makeTitleIdentityContext() {
  const context = {
    String,
    RegExp,
    procurementProductFamilies: () => ({storage: 1}),
    procurementSubType: () => ({}),
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementTitleFamilyConflict'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementDistinctiveTitleConflict'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementFamilyConflict'), context);
  return context;
}

function makeFallbackContext() {
  const context = makePostMergeContext();
  const checksStart = sidepanelSource.indexOf('var POST_MERGE_CHECKS = {');
  const checksEnd = sidepanelSource.indexOf('\n};', checksStart) + 3;
  vm.runInContext(sidepanelSource.slice(checksStart, checksEnd), context);
  vm.runInContext(extractFunction(sidepanelSource, 'checkQuantityExplosion'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'checkSpecLineCount'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'checkDuplicateSpecLines'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'PostMergeResult'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'postMergeVerify'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'isUnsafePostMergeResult'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'copyProcurementSourcePlan'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementPlanStats'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'isolatedProcurementOperation'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementSourcePlanInScope'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'recoverBlockedProcurementPlans'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'collectExecutedStatusUpgradeRecordIds'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'preparePostMergeProcurementPlan'), context);
  return context;
}

test('afternoon post-return scopes procurement writes to the exact platform', async () => {
  const {context, calls} = makeAfternoonContext();
  const result = await context.runAfternoonPostReturn('returnBtn', {
    platform: '京东-【7207】',
    pendingStaleIds: ['stale-1'],
    updated: 18,
    created: 1,
    snapshotRawCount: 32,
    snapshotProductCount: 19,
    snapshotMergeRate: '40.6',
    snapshotQty: 174,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(calls.sync)), [{
    incrementalPlatform: '京东-【7207】',
    excludedSourceIds: ['stale-1'],
  }]);
  assert.equal('fullRepair' in calls.sync[0], false);
  assert.equal(result.ok, true);
  assert.equal(context._lastReturnWorkflowResult.snapshotRawCount, 32);
  assert.equal(context._lastReturnWorkflowResult.snapshotProductCount, 19);
  assert.equal(context._lastReturnWorkflowResult.snapshotMergeRate, '40.6');
  assert.equal(context._lastReturnWorkflowResult.snapshotQty, 174);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.verify[0][3].excludedRecordIds)),
    ['stale-1'],
  );
});

test('procurement fail closed stops verification cleanup tracking and success notice', async () => {
  const {context, calls} = makeAfternoonContext({ok: false, stage: 'post_merge_fallback'});
  const result = await context.runAfternoonPostReturn('returnBtn', {
    platform: '京东-【7207】',
    pendingStaleIds: ['stale-1'],
    updated: 18,
    created: 1,
    snapshotRawCount: 32,
    snapshotProductCount: 19,
    snapshotMergeRate: '40.6',
    snapshotQty: 174,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'post_merge_fallback');
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.cleanup, 0);
  assert.equal(calls.tracker, 0);
  assert.equal(calls.notices, 0);
  assert.equal(calls.ended.at(-1)[1], false);
});

test('verification excludes pending stale records from count and duplicate checks', async () => {
  const current = Array.from({length: 19}, (_, index) => ({
    record_id: `current-${index}`,
    fields: {
      date: Date.now(),
      platform: '京东-【7207】',
      title: `商品${index}`,
      pid: `PID${index}`,
      spec: `规格${index};1`,
      image: 'https://example.test/image.jpg',
    },
  }));
  const stale = Array.from({length: 17}, (_, index) => ({
    record_id: `stale-${index}`,
    fields: {
      date: Date.now(),
      platform: '京东-【7207】',
      title: `旧商品${index}`,
      pid: `PID${index % 9}`,
      spec: `旧规格${index};1`,
      image: 'https://example.test/old.jpg',
    },
  }));
  const context = {
    Promise,
    Number,
    String,
    Object,
    isFinite,
    L: () => {},
    getFieldMap: () => Promise.resolve({}),
    fetchAllRecordsForReturn: () => Promise.resolve(current.concat(stale)),
    resolveField: (_fm, names) => ({
      '🏗 【创建/绑定】日期': 'date',
      '平台所属账号': 'platform',
      '📡 商品全称': 'title',
      '🔗 商品ID': 'pid',
      '🚧 ❗【时段】产品需求值': 'spec',
      '📠 产品图URL': 'image',
    })[names[0]] || '',
    isTodayBusinessValue: () => true,
    matchPlatformAccount: (value, expected) => value === expected,
    sv: (value) => String(value || ''),
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'verifyUpload'), context);

  const result = await context.verifyUpload(19, '下午回传', '京东-【7207】', {
    expectedSafeCount: 19,
    excludedRecordIds: stale.map((record) => record.record_id),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    total: 19,
    issues: 0,
    warnings: 0,
  });
});

test('verification accepts an intentionally split PID when every title and spec pair conflicts', async () => {
  const records = [
    {record_id: 'remote-box', fields: {
      date: Date.now(), platform: '京东-【7205】', title: '遥控器收纳盒',
      pid: '10035236673083', spec: '遥控器收纳盒;1', image: 'https://example.test/a.jpg',
    }},
    {record_id: 'phone-holder', fields: {
      date: Date.now(), platform: '京东-【7205】', title: '车载手机支架',
      pid: '10035236673083', spec: '手机支架;1', image: 'https://example.test/b.jpg',
    }},
  ];
  const context = {
    Promise, Number, String, Object, isFinite,
    L: () => {},
    getFieldMap: () => Promise.resolve({}),
    fetchAllRecordsForReturn: () => Promise.resolve(records),
    resolveField: (_fm, names) => ({
      '🏗 【创建/绑定】日期': 'date', '平台所属账号': 'platform',
      '📡 商品全称': 'title', '🔗 商品ID': 'pid',
      '🚧 ❗【时段】产品需求值': 'spec', '📠 产品图URL': 'image',
    })[names[0]] || '',
    isTodayBusinessValue: () => true,
    matchPlatformAccount: (value, expected) => value === expected,
    strictMergeEvidence: () => false,
    sv: (value) => String(value || ''),
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'verifyUpload'), context);

  const result = await context.verifyUpload(2, '下午回传', '京东-【7205】');

  assert.equal(result.ok, true);
  assert.equal(result.warnings, 0);
});

test('verification still warns when duplicate PID rows have mergeable identity evidence', async () => {
  const records = [
    {record_id: 'same-a', fields: {
      date: Date.now(), platform: '京东-【7205】', title: '同款车载手机支架',
      pid: 'PID-SAME', spec: '黑色;1', image: 'https://example.test/a.jpg',
    }},
    {record_id: 'same-b', fields: {
      date: Date.now(), platform: '京东-【7205】', title: '同款车载手机支架',
      pid: 'PID-SAME', spec: '白色;1', image: 'https://example.test/b.jpg',
    }},
  ];
  const context = {
    Promise, Number, String, Object, isFinite,
    L: () => {},
    getFieldMap: () => Promise.resolve({}),
    fetchAllRecordsForReturn: () => Promise.resolve(records),
    resolveField: (_fm, names) => ({
      '🏗 【创建/绑定】日期': 'date', '平台所属账号': 'platform',
      '📡 商品全称': 'title', '🔗 商品ID': 'pid',
      '🚧 ❗【时段】产品需求值': 'spec', '📠 产品图URL': 'image',
    })[names[0]] || '',
    isTodayBusinessValue: () => true,
    matchPlatformAccount: (value, expected) => value === expected,
    strictMergeEvidence: () => true,
    sv: (value) => String(value || ''),
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'verifyUpload'), context);

  const result = await context.verifyUpload(2, '下午回传', '京东-【7205】');

  assert.equal(result.ok, true);
  assert.equal(result.warnings, 1);
});

test('empty afternoon platform stops before procurement sync', async () => {
  const {context, calls} = makeAfternoonContext();
  const result = await context.runAfternoonPostReturn('returnBtn', {
    platform: '',
    pendingStaleIds: ['stale-1'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'scope');
  assert.equal(calls.sync.length, 0);
  assert.equal(calls.ended.at(-1)[1], false);
});

test('afternoon return keeps the full snapshot expectation and cleanup scope', async () => {
  const calls = {verify: [], cleanup: [], tracker: []};
  const context = {
    Promise,
    Date,
    L: () => {},
    _lastReturnWorkflowResult: null,
    syncToProcurement: () => Promise.resolve({
      ok: true,
      updated: 18,
      created: 1,
    }),
    verifyUpload: (...args) => {
      calls.verify.push(args);
      return Promise.resolve({ok: true});
    },
    afternoonWorkflowCanCleanup: () => true,
    finalizeAfternoonSourceCleanup: (ids) => {
      calls.cleanup.push(ids);
      return Promise.resolve({ok: true, deleted: 0});
    },
    trackerRecordAfternoon: (...args) => {
      calls.tracker.push(args);
      return Promise.resolve({ok: true});
    },
    endTask: () => {},
    chrome: {storage: {local: {set: (_value, callback) => callback()}}},
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'runAfternoonPostReturn'), context);

  const result = await context.runAfternoonPostReturn('returnBtn', {
    platform: '京东-【7207】',
    pendingStaleIds: ['stale-1', 'old-2'],
    safeSnapshotRecordCount: 19,
    updated: 18,
    created: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.partialSafe, false);
  assert.equal(calls.verify[0][3].expectedSafeCount, 19);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.verify[0][3].excludedRecordIds)),
    ['stale-1', 'old-2'],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(calls.cleanup)), [['stale-1', 'old-2']]);
  assert.equal(calls.tracker[0][2], 'done');
});

test('incremental procurement selection keeps only affected rows and exact platform matches', () => {
  const context = {String, Array};
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementPlatformContains'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'selectIncrementalProcurementPlan'), context);

  const updates = Array.from({length: 1325}, (_, index) => ({
    id: `update-${index}`,
    affected: index < 32,
  }));
  const creates = [
    {id: 'affected-create', affected: true},
    {id: 'unaffected-create', affected: false},
  ];
  const plan = context.selectIncrementalProcurementPlan(
    updates,
    creates,
    [],
    '京东-【7207】',
    '平台【文字】',
  );

  assert.equal(plan.updates.length, 32);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.creates)), [creates[0]]);
  assert.equal(
    context.procurementPlatformContains('京东-【7207】', '京东-【7205】'),
    false,
  );
  assert.equal(
    context.procurementPlatformContains('淘宝-【7207】\n京东-【7207】', '京东-【7207】'),
    true,
  );
});

test('strict incremental PID matching rejects another account or zone', () => {
  const context = makeMatchContext();
  const otherZone = {
    record_id: 'jd-7205',
    fields: {'📡 商品全称': '同一商品', '平台所属账号': '京东-【7205】'},
  };
  const lookup = {byPid: {PID1: [otherZone]}, byTitle: {}, byPidSpec: {}};

  assert.equal(
    context.matchRecord('PID1', '同一商品', lookup, '京东-【7207】', true),
    null,
  );
});

test('same canonical title chooses the printed main row over a historical split row', () => {
  const context = makeMatchContext();
  const title = '【出行好物】二合一便携防水收纳袋可悬挂大容量运动鞋拖鞋家用外用分装袋';
  const split = {
    record_id: 'split-unprinted',
    fields: {
      '📡 商品全称': title + ' [拆分]',
      '平台所属账号': '微信小店-【5820】',
      '手动传输状态': '未打单',
    },
  };
  const main = {
    record_id: 'main-printed',
    fields: {
      '📡 商品全称': title,
      '平台所属账号': '微信小店-【5820】',
      '手动传输状态': '已打单',
    },
  };
  const key = context.canonicalProcurementTitleKey(title);
  const result = context.matchRecord('', title, {
    byPid: {},
    byPidSpec: {},
    byTitle: {[key]: [split, main]},
  }, '微信小店-【5820】', false);

  assert.equal(result.rec, main);
  assert.equal(result.type, 'TITLE');

  const pidResult = context.matchRecord('PID-ROTATED', title, {
    byPid: {'PID-ROTATED': [split, main]},
    byPidSpec: {},
    byTitle: {[key]: [split, main]},
  }, '微信小店-【5820】', false);
  assert.equal(pidResult.rec, main);
  assert.equal(pidResult.type, 'PID');
});

test('post-merge verification accepts every declared family in a multi-family title', () => {
  const context = makePostMergeContext();

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.extractCoreProductFamilies(
      '新款指尖陀螺可变形机器人儿童玩具',
    ).sort())),
    ['玩偶', '陀螺'],
  );
  assert.equal(
    context.checkSpecCrossContamination(
      '新款指尖陀螺可变形机器人儿童玩具',
      '指尖陀螺【3个装】;1',
    ).contaminated,
    false,
  );
});

test('post-merge verification still blocks an unrelated family', () => {
  const context = makePostMergeContext();

  assert.equal(
    context.checkSpecCrossContamination('家用穿针器', '鼻毛修剪器;45').contaminated,
    true,
  );
});

test('post-merge verification accepts shoe bags declared as a travel-set component', () => {
  const context = makePostMergeContext();

  const result = context.checkSpecCrossContamination(
    '大容量五件套旅行出差压缩收纳袋多色可选独立分装',
    '【米色5件套】大号/中号/内衣袋/睡衣袋/鞋袋;1\n【雾蓝5件套】大号/中号/内衣袋/睡衣袋/鞋袋;1',
  );
  assert.equal(
    result.contaminated,
    false,
  );
});

test('post-merge verification still blocks a standalone shoe bag mixed into that travel set', () => {
  const context = makePostMergeContext();

  assert.equal(
    context.checkSpecCrossContamination(
      '大容量五件套旅行出差压缩收纳袋多色可选独立分装',
      '【米色5件套】大号/中号/内衣袋/睡衣袋/鞋袋;1\n二合一防水鞋袋【高级灰-1个装】;239',
    ).contaminated,
    true,
  );
});

test('post-merge verification accepts shoe-bag specs for a shoe-bag title', () => {
  const context = makePostMergeContext();
  assert.equal(
    context.checkSpecCrossContamination(
      '【出行好物】二合一便携防水收纳袋可悬挂大容量运动鞋拖鞋家用外用分装袋',
      '二合一防水鞋袋【高级灰-1个装】;239\n二合一防水鞋袋【暖杏色-1个装】;249',
    ).contaminated,
    false,
  );
});

test('post-merge verification accepts filter-bag specs for a filter-bag title', () => {
  const context = makePostMergeContext();
  assert.equal(
    context.checkSpecCrossContamination(
      'LL冷热水龙头过滤棉袋自来水山泉水通用铁锈杂质滤水器',
      '过滤袋【通用款】;5',
    ).contaminated,
    false,
  );
});

test('title identity separates a shoe-bag listing from a generic travel storage bundle', () => {
  const context = makeTitleIdentityContext();

  assert.equal(
    context.procurementTitleFamilyConflict(
      '【出行好物】二合一便携防水收纳袋可悬挂大容量运动鞋拖鞋家用外用分装袋',
      '大容量五件套旅行出差压缩收纳袋多色可选独立分装',
    ),
    true,
  );
  assert.equal(
    context.procurementTitleFamilyConflict(
      '【出行好物】二合一便携防水收纳袋可悬挂大容量运动鞋拖鞋家用外用分装袋',
      '【出行好物】二合一便携防水收纳袋可悬挂大容量旅行收纳运动鞋拖鞋家用分装袋',
    ),
    false,
  );
  assert.equal(
    context.procurementFamilyConflict(
      {
        title: '【出行好物】二合一便携防水收纳袋可悬挂大容量运动鞋拖鞋家用外用分装袋',
        spec: '二合一防水鞋袋【高级灰-1个装】;239',
      },
      {
        title: '大容量五件套旅行出差压缩收纳袋多色可选独立分装',
        spec: '【米色5件套】大号/中号/内衣袋/睡衣袋/鞋袋;1',
      },
    ),
    true,
  );
});

test('distinctive marked title names block rare-core merges between different designs', () => {
  const context = makeTitleIdentityContext();

  assert.equal(
    context.procurementDistinctiveTitleConflict(
      '印刷书法正品加大《规矩》挂画新中式字画玄关客厅书',
      '印刷书法《家道》书法挂画新中式家风家训客厅玄关书',
    ),
    true,
  );
  assert.equal(
    context.procurementDistinctiveTitleConflict(
      '印刷书法正品加大《规矩》挂画新中式字画玄关客厅书',
      '印刷书法加大《规矩》书法挂画新中式客厅玄关书',
    ),
    false,
  );
});

test('same single-line source family is retained instead of being blocked by title wording', () => {
  const context = makeFallbackContext();
  const result = context.postMergeVerify({
    title: '【9.9包邮】粘贴遥控器收纳盒壁挂床头手机空调遥控收纳神器F',
    mergedSpec: '手机壁挂支架【8个装】颜色随机;10',
    originalSpecs: [
      '手机壁挂支架【8个装】颜色随机;3',
      '手机壁挂支架【8个装】颜色随机;1',
    ],
    sourcePlans: [
      {title: '【9.9包邮】粘贴遥控器收纳盒壁挂床头手机空调遥控收纳神器F', spec: '手机壁挂支架【8个装】颜色随机;3'},
      {title: '【9.9包邮】粘贴遥控器收纳盒壁挂床头手机空调遥控收纳神器F', spec: '手机壁挂支架【8个装】颜色随机;1'},
    ],
  });

  assert.equal(result.severity, 'warn');
  assert.equal(
    result.issues.some((issue) => issue.type === 'CROSS_FAMILY_CONTAMINATION' && issue.level === 'block'),
    false,
  );
});

test('unsafe merged groups restore original title-spec pairs instead of inventing a split title', () => {
  const context = {String, Array, Object};
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'restoreMergeGroupSourceRecords'), context);

  const restored = context.restoreMergeGroupSourceRecords({
    title: '遥控器收纳盒',
    specStr: '遥控器收纳盒;1\n手机支架;1',
    sourceItems: [
      {productId: 'PID-1', title: '遥控器收纳盒', specs: [{name: '遥控器收纳盒', qty: 1}], imgSrc: 'A', platform: '拼多多-【7205】'},
      {productId: 'PID-1', title: '车载手机支架', specs: [{name: '手机支架', qty: 1}], imgSrc: 'B', platform: '拼多多-【7205】'},
    ],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(restored)), [
    {title: '遥控器收纳盒', productId: 'PID-1', imgSrc: 'A', specStr: '遥控器收纳盒;1', platform: '拼多多-【7205】'},
    {title: '车载手机支架', productId: 'PID-1', imgSrc: 'B', specStr: '手机支架;1', platform: '拼多多-【7205】'},
  ]);
  assert.equal(restored.some((item) => item.title.includes('[拆分]')), false);
});

test('post-merge diagnostics identify the exact unsafe source plan', () => {
  const context = {String, Array};
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'describePostMergeUnresolved'), context);

  assert.equal(
    context.describePostMergeUnresolved({
      sourcePlan: {sourceId: 'src-123', title: '遥控器收纳盒', spec: '手机支架;1'},
      result: {issues: [{type: 'CROSS_FAMILY_CONTAMINATION'}]},
    }),
    'CROSS_FAMILY_CONTAMINATION | source=src-123 | title=遥控器收纳盒 | spec=手机支架;1',
  );
});

test('blocked update falls back to one safe update and isolated creates with conserved sources and quantity', () => {
  const context = makeFallbackContext();
  const updates = [{
    record_id: 'rec-1',
    matchType: 'PID',
    fields: {title: '机器人玩具', spec: '变形机器人;20\n指尖陀螺;27'},
    sourcePlans: [
      {sourceId: 'source-1', title: '变形机器人玩具', spec: '变形机器人;20', fields: {title: '变形机器人玩具', spec: '变形机器人;20'}},
      {sourceId: 'source-2', title: '指尖陀螺', spec: '指尖陀螺;27', fields: {title: '指尖陀螺', spec: '指尖陀螺;27'}},
    ],
  }];
  const report = {
    results: [{group: {operation: updates[0]}, result: {severity: 'block'}}],
  };

  const result = context.recoverBlockedProcurementPlans(
    updates,
    [],
    report,
    {title: 'title', spec: 'spec'},
  );

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.updates.map((item) => item.record_id))), ['rec-1']);
  assert.equal(result.creates.length, 1);
  assert.equal(result.creates[0].matchType, 'CREATE_ISOLATED');
  assert.equal(result.sourceCount, 2);
  assert.equal(result.qtyTotal, 47);
  assert.equal(result.updates[0].sourcePlans.length, 1);
  assert.equal(result.creates[0].sourcePlans.length, 1);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('isolated create preserves the source image, attachment metadata, and writes a fresh date', () => {
  const context = makeFallbackContext();
  const updates = [{
    record_id: 'rec-1',
    fields: {title: '机器人玩具', spec: '变形机器人;20\n指尖陀螺;27', platform: '京东-【7207】'},
    sourcePlans: [
      {
        sourceId: 'source-a',
        title: '变形机器人玩具',
        spec: '变形机器人;20',
        platform: '京东-【7207】',
        imageUrl: 'A图',
        needsAttachment: false,
        attachmentValue: ['att-A'],
        fields: {title: '变形机器人玩具', spec: '变形机器人;20', platform: '京东-【7207】', image: 'A图', status: '未打单', attachment: ['att-A']},
      },
      {
        sourceId: 'source-b',
        title: '指尖陀螺',
        spec: '指尖陀螺;27',
        platform: '京东-【7207】',
        imageUrl: 'B图',
        needsAttachment: true,
        attachmentValue: ['att-B'],
        fields: {title: '指尖陀螺', spec: '指尖陀螺;27', platform: '京东-【7207】', image: 'B图', status: '已打单', attachment: ['att-B']},
      },
    ],
  }];
  const before = Date.now();
  const result = context.recoverBlockedProcurementPlans(
    updates,
    [],
    {results: [{group: {operation: updates[0]}, result: {severity: 'block'}}]},
    {title: 'title', spec: 'spec', platform: 'platform', image: 'image', attachment: 'attachment', dateWrite: 'date', status: 'status'},
    '京东-【7207】',
    {sourceCount: 2, qtyTotal: 47},
  );

  assert.equal(result.ok, true);
  assert.equal(result.creates.length, 1);
  assert.equal(result.creates[0].imageUrl, 'B图');
  assert.equal(result.creates[0].needsAttachment, true);
  assert.equal(result.creates[0].fields.image, 'B图');
  assert.deepEqual(JSON.parse(JSON.stringify(result.creates[0].fields.attachment)), ['att-B']);
  assert.ok(result.creates[0].fields.date >= before);
  assert.ok(result.creates[0].fields.date <= Date.now());
});

test('blocked create is split into independent isolated creates', () => {
  const context = makeFallbackContext();
  const creates = [{
    fields: {title: '机器人玩具', spec: '变形机器人;20\n指尖陀螺;27'},
    sourcePlans: [
      {sourceId: 'source-1', title: '变形机器人玩具', spec: '变形机器人;20', fields: {title: '变形机器人玩具', spec: '变形机器人;20'}},
      {sourceId: 'source-2', title: '指尖陀螺', spec: '指尖陀螺;27', fields: {title: '指尖陀螺', spec: '指尖陀螺;27'}},
    ],
  }];
  const report = {
    results: [{group: {operation: creates[0]}, result: {severity: 'block'}}],
  };

  const result = context.recoverBlockedProcurementPlans(
    [],
    creates,
    report,
    {title: 'title', spec: 'spec'},
  );

  assert.equal(result.ok, true);
  assert.equal(result.updates.length, 0);
  assert.equal(result.creates.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.creates.map((item) => item.matchType))),
    ['CREATE_ISOLATED', 'CREATE_ISOLATED'],
  );
  assert.equal(result.sourceCount, 2);
  assert.equal(result.qtyTotal, 47);
});

test('fallback fails closed when any original source remains blocked', () => {
  const context = makeFallbackContext();
  const updates = [{
    record_id: 'rec-unsafe',
    fields: {title: '家用穿针器', spec: '鼻毛修剪器;45'},
    sourcePlans: [
      {sourceId: 'unsafe', title: '家用穿针器', spec: '鼻毛修剪器;45', fields: {title: '家用穿针器', spec: '鼻毛修剪器;45'}},
    ],
  }];
  const report = {
    results: [{group: {operation: updates[0]}, result: {severity: 'block'}}],
  };

  const result = context.recoverBlockedProcurementPlans(
    updates,
    [],
    report,
    {title: 'title', spec: 'spec'},
  );

  assert.equal(result.ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.updates)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(result.creates)), []);
  assert.equal(result.unresolved.length, 1);
});

test('fallback still fails closed for a genuinely mixed source group', () => {
  const context = makeFallbackContext();
  const creates = [{
    fields: {title: '遥控器收纳盒', spec: '手机壁挂支架;5\n遥控器收纳盒;2'},
    sourcePlans: [
      {sourceId: 'bad-source', title: '遥控器收纳盒', spec: '手机壁挂支架;5', platform: '拼多多-【7205】', fields: {title: '遥控器收纳盒', spec: '手机壁挂支架;5', platform: '拼多多-【7205】'}},
      {sourceId: 'safe-source', title: '遥控器收纳盒', spec: '遥控器收纳盒;2', platform: '拼多多-【7205】', fields: {title: '遥控器收纳盒', spec: '遥控器收纳盒;2', platform: '拼多多-【7205】'}},
    ],
  }];
  const result = context.recoverBlockedProcurementPlans(
    [],
    creates,
    {results: [{group: {operation: creates[0]}, result: {severity: 'block'}}]},
    {title: 'title', spec: 'spec', platform: 'platform'},
    '拼多多-【7205】',
    {sourceCount: 2, qtyTotal: 7},
  );

  assert.equal(result.ok, false);
  assert.equal(result.unresolved.length, 1);
});

test('executed status upgrades only include IDs from a successful batch', () => {
  const context = makeFallbackContext();
  const batch = [{record_id: 'rec-1'}, {record_id: 'rec-2'}, {record_id: 'rec-3'}];

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.collectExecutedStatusUpgradeRecordIds(
      batch,
      { 'rec-1': true, 'rec-3': true, 'rec-4': true },
      'status',
    ))),
    {},
  );
});

test('executed status upgrades require the successful update payload to say printed', () => {
  const context = makeFallbackContext();
  const batch = [
    {record_id: 'rec-1', fields: {status: '未打单'}},
    {record_id: 'rec-2', fields: {status: '已打单'}},
  ];

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.collectExecutedStatusUpgradeRecordIds(
      batch,
      {'rec-1': true, 'rec-2': true},
      'status',
    ))),
    {'rec-2': true},
  );
});

test('unsafe empty-spec warning fails the write-plan decision before batch writes', () => {
  const context = makeFallbackContext();
  const updates = [{
    record_id: 'rec-empty',
    fields: {title: '机器人玩具', spec: ''},
    sourcePlans: [{title: '机器人玩具', spec: '', platform: '京东-【7207】', fields: {title: '机器人玩具', spec: ''}}],
  }];
  const decision = context.preparePostMergeProcurementPlan(
    updates,
    [],
    {results: [{group: {operation: updates[0]}, result: {severity: 'warn', issues: [{type: 'EMPTY_MERGED_SPEC'}]}}]},
    {title: 'title', spec: 'spec', platform: 'platform', dateWrite: 'date'},
    '京东-【7207】',
    {sourceCount: 1, qtyTotal: 0},
  );

  assert.equal(decision.ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(decision.updates)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(decision.creates)), []);
  assert.equal(decision.reason, 'post_merge_fallback');
});

test('mixed 7205 and 7207 source fails closed during a 7207 scoped return', () => {
  const context = makeFallbackContext();
  const updates = [{
    record_id: 'rec-mixed',
    fields: {title: '机器人玩具', spec: '变形机器人;20\n指尖陀螺;27'},
    sourcePlans: [{
      title: '机器人玩具',
      spec: '变形机器人;20\n指尖陀螺;27',
      platform: '京东-【7205】\n京东-【7207】',
      fields: {title: '机器人玩具', spec: '变形机器人;20\n指尖陀螺;27', platform: '京东-【7205】\n京东-【7207】'},
    }],
  }];
  const decision = context.preparePostMergeProcurementPlan(
    updates,
    [],
    {results: [{group: {operation: updates[0]}, result: {severity: 'block'}}]},
    {title: 'title', spec: 'spec', platform: 'platform'},
    '京东-【7207】',
    {sourceCount: 1, qtyTotal: 47},
  );

  assert.equal(decision.ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(decision.updates)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(decision.creates)), []);
  assert.equal(decision.reason, 'post_merge_fallback');
});

test('fallback compares the frozen incremental source and quantity expectation', () => {
  const context = makeFallbackContext();
  const updates = [{
    record_id: 'rec-expected',
    fields: {title: '机器人玩具', spec: '变形机器人;20'},
    sourcePlans: [{title: '变形机器人玩具', spec: '变形机器人;20', fields: {title: '变形机器人玩具', spec: '变形机器人;20'}}],
  }];
  const decision = context.preparePostMergeProcurementPlan(
    updates,
    [],
    {results: [{group: {operation: updates[0]}, result: {severity: 'block'}}]},
    {title: 'title', spec: 'spec'},
    '',
    {sourceCount: 2, qtyTotal: 99},
  );

  assert.equal(decision.ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(decision.updates)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(decision.creates)), []);
  assert.equal(decision.reason, 'post_merge_fallback');
});

test('procurement source plans retain the exact source platform even when the target platform field is not writable', () => {
  // V20.29.0: 稳定版等价实现 —— 平台作用域通过 affected 字段传播（incrementalPlatform）
  assert.match(
    sidepanelSource,
    /affected:\s*procurementPlatformContains\(src\.platform,\s*incrementalPlatform\)/,
  );
  assert.match(sidepanelSource, /queueProcUpdate\(\{[\s\S]*?affected:/);
  assert.match(sidepanelSource, /queueProcCreate\(\{[\s\S]*?affected:/);
});

test('strict incremental PID matching accepts a target multi-platform group containing the source', () => {
  const context = makeMatchContext();
  const merged = {
    record_id: 'merged-jd',
    fields: {
      '📡 商品全称': '同一商品',
      '平台所属账号': '京东-【7205】\n京东-【7207】',
    },
  };
  const lookup = {byPid: {PID1: [merged]}, byTitle: {}, byPidSpec: {}};

  assert.equal(
    context.matchRecord('PID1', '同一商品', lookup, '京东-【7207】', true).rec,
    merged,
  );
});

test('strict incremental title, fuzzy, and empty-platform matching never cross scope', () => {
  const context = makeMatchContext();
  const otherZone = {
    record_id: 'jd-7205',
    fields: {'📡 商品全称': '同一商品旧版', '平台所属账号': '京东-【7205】'},
  };
  const lookup = {
    byPid: {},
    byPidSpec: {},
    byTitle: {
      '同一商品': [otherZone],
      '同一商品旧版': [otherZone],
    },
  };

  assert.equal(context.matchRecord('', '同一商品', lookup, '京东-【7207】', true), null);
  assert.equal(context.matchRecord('', '同一商品旧版x', lookup, '京东-【7207】', true), null);
  assert.equal(context.matchRecord('PID1', '同一商品', {
    byPid: {PID1: [otherZone]}, byTitle: {}, byPidSpec: {},
  }, '', true), null);
});

test('strict incremental title matching rejects another account or zone', () => {
  const context = makeMatchContext();
  const otherZone = {
    record_id: 'jd-7205-title',
    fields: {'📡 商品全称': '同一商品', '平台所属账号': '京东-【7205】'},
  };
  assert.equal(context.matchRecord('', '同一商品', {
    byPid: {}, byPidSpec: {}, byTitle: {'同一商品': [otherZone]},
  }, '京东-【7207】', true), null);
});

test('strict incremental fuzzy matching rejects another account or zone', () => {
  const context = makeMatchContext();
  const otherZone = {
    record_id: 'jd-7205-fuzzy',
    fields: {'📡 商品全称': '同一商品旧版', '平台所属账号': '京东-【7205】'},
  };
  assert.equal(context.matchRecord('', '同一商品旧版x', {
    byPid: {}, byPidSpec: {}, byTitle: {'同一商品旧版': [otherZone]},
  }, '京东-【7207】', true), null);
});

test('non-strict fullRepair matching preserves the existing cross-platform fallback', () => {
  const context = makeMatchContext();
  const otherZone = {
    record_id: 'jd-7205',
    fields: {'📡 商品全称': '同一商品', '平台所属账号': '京东-【7205】'},
  };
  const result = context.matchRecord('PID1', '同一商品', {
    byPid: {PID1: [otherZone]}, byPidSpec: {}, byTitle: {},
  }, '京东-【7207】', false);
  assert.equal(result.rec, otherZone);
});

test('strict vector candidate scope excludes 7205 and keeps a group containing 7207', () => {
  const context = {String, Array};
  vm.createContext(context);
  vm.runInContext(extractFunction(sidepanelSource, 'procurementPlatformContains'), context);
  vm.runInContext(extractFunction(sidepanelSource, 'scopeProcurementVectorCandidates'), context);
  const candidates = [
    {id: 'jd-7205', platform: '京东-【7205】'},
    {id: 'merged-jd', platform: '京东-【7205】\n京东-【7207】'},
  ];

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.scopeProcurementVectorCandidates(candidates, '京东-【7207】', true),
    )),
    [candidates[1]],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.scopeProcurementVectorCandidates(candidates, '京东-【7207】', false),
    )),
    candidates,
  );
});

test('automation summary reports raw rows, merged products, merge rate, quantity, and writes', () => {
  const context = {String, Number};
  vm.createContext(context);
  vm.runInContext(extractFunction(automationSource, 'formatAfternoonSummary'), context);
  const summary = context.formatAfternoonSummary({
    snapshotRawCount: 32,
    snapshotProductCount: 19,
    snapshotMergeRate: '40.6',
    snapshotQty: 174,
    updated: 18,
    created: 1,
    procurementUpdated: 18,
    procurementCreated: 1,
  });

  assert.equal(
    summary,
    '页面 32 条 → 19 个商品，合并率 40.6%，数量 174；中转站更新 18，新增 1；采购表更新 18，新增 1',
  );
});

test('afternoon completion card uses three readable sections instead of bullet text', () => {
  const context = {String, Number};
  vm.createContext(context);
  vm.runInContext(extractFunction(automationSource, 'formatAfternoonCardElements'), context);
  const elements = context.formatAfternoonCardElements({
    snapshotRawCount: 32,
    snapshotProductCount: 19,
    snapshotMergeRate: '40.6',
    snapshotQty: 174,
    updated: 19,
    created: 0,
    procurementUpdated: 19,
    procurementCreated: 0,
  });

  // V20.29.0: 丰富卡片设计（用户有意演进：数据概览多列 + 写入结果表格 + 状态信息）
  assert.deepEqual(
    JSON.parse(JSON.stringify(elements.map((element) => element.tag))),
    ['div', 'column_set', 'hr', 'div', 'table', 'hr', 'div', 'div', 'hr', 'action', 'hr', 'note'],
  );
  // 概览 section：数据概览 + 原始数据/合并商品统计
  assert.match(elements[0].text.content, /数据概览/);
  const overviewJson = JSON.stringify(elements[1]);
  assert.match(overviewJson, /原始数据/);
  assert.match(overviewJson, /32 条/);
  assert.match(overviewJson, /合并商品/);
  assert.match(overviewJson, /19 个/);
  // 写入结果 section：写入结果 + 表格（中转站/采购表更新）
  assert.match(elements[3].text.content, /写入结果/);
  const tableJson = JSON.stringify(elements[4]);
  assert.match(tableJson, /中转站/);
  assert.match(tableJson, /更新/);
  assert.match(tableJson, /采购表/);
  // 状态 section：数据校验通过
  assert.match(elements[7].text.content, /数据校验通过/);
});

test('manual successful return delegates exactly one unified completion notice', async () => {
  const {context, calls} = makeManualNotificationContext(false);
  const result = await context.notifyManualReturnCompletion({
    ok: true,
    platform: '京东-【7207】',
  }, '下午回传');

  assert.equal(result.ok, true);
  assert.equal(calls.notices, 1);
  assert.equal(calls.noticeArgs[0][0], '✅ 京东-【7207】 · 回传完成');
  assert.equal(calls.noticeArgs[0][3][0].text.content, 'card');
});

test('automatic successful return skips manual notice and clears the automation marker', async () => {
  const {context, calls} = makeManualNotificationContext(true);
  const result = await context.notifyManualReturnCompletion({
    ok: true,
    platform: '京东-【7207】',
  }, '下午回传');

  assert.equal(result.skipped, 'automation');
  assert.equal(context.window._dgjAutomationReturn, false);
  assert.equal(calls.notices, 0);
});

test('failed workflow clears automation marker and sends no success notice', async () => {
  const {context, calls} = makeManualNotificationContext(true);
  const result = await context.notifyManualReturnCompletion({
    ok: false,
    platform: '京东-【7207】',
  }, '下午回传');

  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'workflow_failed');
  assert.equal(context.window._dgjAutomationReturn, false);
  assert.equal(calls.notices, 0);
});

test('post-merge procurement failure reaches manual completion without sending a notice', async () => {
  const afternoon = makeAfternoonContext({ok: false, stage: 'post_merge_fallback'});
  const workflowResult = await afternoon.context.runAfternoonPostReturn('returnBtn', {
    platform: '京东-【7207】',
    pendingStaleIds: ['stale-1'],
    updated: 18,
    created: 1,
  });
  const manual = makeManualNotificationContext(false);
  const noticeResult = await manual.context.notifyManualReturnCompletion(
    workflowResult,
    '下午回传',
  );

  assert.equal(workflowResult.ok, false);
  assert.equal(workflowResult.stage, 'post_merge_fallback');
  assert.equal(noticeResult.ok, false);
  assert.equal(noticeResult.skipped, 'workflow_failed');
  assert.equal(manual.calls.notices, 0);
});

test('automation refreshes completion progress before notification and keeps the exact account platform', () => {
  const start = automationSource.indexOf('var summary = formatAfternoonSummary(result);');
  const end = automationSource.indexOf('}).catch(function(error)', start);
  const successChain = automationSource.slice(start, end);
  const refreshAt = successChain.indexOf('return autoRenderStatus()');
  const notifyAt = successChain.indexOf('notifyCompletionSafely(');

  assert.ok(refreshAt >= 0, 'completion chain must refresh automation progress');
  assert.ok(notifyAt >= 0, 'completion chain must send the unified notification');
  assert.ok(refreshAt < notifyAt, 'progress refresh must happen before notification');
  assert.match(
    successChain,
    /'结果摘要':command\.platform \+ '-【' \+ command\.accountTail \+ '】；'/,
  );
});

test('completion notification failure resolves as a notification-only failure', async () => {
  const context = {
    Promise,
    L: () => {},
    autoNotify: () => Promise.reject(new Error('webhook unavailable')),
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(automationSource, 'notifyCompletionSafely'), context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(await context.notifyCompletionSafely('完成', ['内容'], 'green'))),
    {ok: false},
  );
});

console.log(`afternoon-scoped-return.test: ${pluginRoot.pathname}`);
