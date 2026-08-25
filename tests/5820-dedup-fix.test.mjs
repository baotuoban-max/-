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

function makeMatchContext() {
  const context = {
    console,
    L: () => {},
    sv: (v) => typeof v === 'string' ? v.trim() : '',
    norm: (t) => (t || '').replace(/\s+/g, '').toLowerCase(),
    jaroWinkler: (a, b) => a === b ? 1 : 0.5,
    normTitle: null,
    procurementHasSplitTitleMarker: null,
    canonicalProcurementTitleKey: null,
    procurementTitleIdentityExact: null,
    chooseProcurementTitleRecord: null,
    matchRecord: null,
    procurementProfileIdentitySafe: null,
    strictSpecTitleConsistency: null,
    procurementFamilyConflict: null,
    procurementModelConflict: null,
    coreProductConflict: null,
    procurementDistinctiveTitleConflict: null,
    extractRecFields: null,
    buildLookupMaps: null,
    strictMergeEvidence: null,
    extractCoreProductNoun: null,
    extractCoreProductFamilies: null,
    normTitle: null,
  };
  vm.createContext(context);
  
  const functions = [
    'normTitle', 'procurementHasSplitTitleMarker', 'canonicalProcurementTitleKey',
    'procurementTitleIdentityExact', 'chooseProcurementTitleRecord', 'matchRecord',
    'procurementProfileIdentitySafe', 'strictSpecTitleConsistency',
    'procurementFamilyConflict', 'procurementModelConflict',
    'procurementTitleFamilyConflict', 'procurementProductFamilies', 'procurementSubType',
    'procurementModelTokens',
    'procurementKeywordConcepts', 'procurementCoreTitleText', 'procurementCoreTitleNgrams',
    'procurementProfileCoreNgrams', 'procurementInformativeSpecKeys', 'procurementRareCoreEvidence',
    'procurementFeatureSimilarity', 'procurementProductFeatures', 'procurementSharedKeywordConcept',
    'buildProcurementCorpusStats', 'removeStopWords', 'extractCategory', 'hasCategoryConflict',
    'extractProductType', 'enhancedCategoryConflict', 'specTitleConsistencyCheck',
    'extractSpecStructure', 'compareSpecStructure', 'specNgramSimilarity', 'enhancedSpecEvidence',
    'procurementSpecEvidence', 'normalizeProcurementSpecName', 'procurementSpecInformation',
    'procurementSpecQtyTotal', 'procurementTitleContainment', 'norm', 'jaroWinkler', 'diceSim',
    'triSim', 'cosineSim', 'cnTokenize', 'tokenJaccard', 'extractSpecNames', 'specOverlap',
    'specTokenOverlap', 'specAvgLen', 'specTrigMax', 'multiSim', 'compositeScore',
    'coreProductConflict', 'procurementDistinctiveTitleConflict',
    'extractRecFields', 'buildLookupMaps', 'strictMergeEvidence',
    'extractCoreProductNoun', 'extractCoreProductFamilies',
  ];
  
  // 注入家族表常量（extractCoreProductNoun 依赖）
  const familyStart = sidepanelSource.indexOf('var CORE_PRODUCT_FAMILIES = {');
  const familyEnd = sidepanelSource.indexOf('\n};', familyStart) + 3;
  vm.runInContext(sidepanelSource.slice(familyStart, familyEnd), context);
  
  for (const fn of functions) {
    try {
      vm.runInContext(extractFunction(sidepanelSource, fn), context);
    } catch (e) {
      // Some functions might not exist
    }
  }
  
  return context;
}

test('5820 dedup: matches today source to existing procurement record', () => {
  const ctx = makeMatchContext();
  
  // Simulate existing records from previous days
  const existingRecords = [
    { record_id: 'recvrzuanMMSW3', fields: {
      '📡 商品全称': '【好物推荐】电动车震动感应彩灯防追尾',
      '商品 🆔': '10001264175580',
      '平台所属账号': '微信小店-【5820】',
      '手动传输状态': '已打单',
    }},
    { record_id: 'recvrc07iHVCAQ', fields: {
      '📡 商品全称': '【好物推荐】电动车震动感应彩灯防追尾',
      '商品 🆔': '10001264175580',
      '平台所属账号': '微信小店-【5820】',
      '手动传输状态': '已打单',
    }},
  ];
  
  const lookup = ctx.buildLookupMaps(existingRecords);
  const result = ctx.matchRecord('10001264175580', '【好物推荐】电动车震动感应彩灯防追尾', lookup, '微信小店-【5820】', false);
  
  assert.ok(result, 'Should match an existing record');
  assert.ok(['recvrzuanMMSW3', 'recvrc07iHVCAQ'].includes(result.rec.record_id),
    'Should match existing record, not create new');
});

test('5820 dedup: matches by title when PID changes', () => {
  const ctx = makeMatchContext();
  
  const existingRecords = [
    { record_id: 'recvrzuanMMSW3', fields: {
      '📡 商品全称': '【好物推荐】电动车震动感应彩灯防追尾',
      '商品 🆔': 'OLD_PID',
      '平台所属账号': '微信小店-【5820】',
      '手动传输状态': '已打单',
    }},
  ];
  
  const lookup = ctx.buildLookupMaps(existingRecords);
  const result = ctx.matchRecord('NEW_PID', '【好物推荐】电动车震动感应彩灯防追尾', lookup, '微信小店-【5820】', false);
  
  assert.ok(result, 'Should match by title');
  assert.equal(result.type, 'TITLE', 'Should be TITLE match');
  assert.equal(result.rec.record_id, 'recvrzuanMMSW3');
});

test('5820 dedup: prefers non-split main record over split record', () => {
  const ctx = makeMatchContext();
  
  const title = '【出行好物】二合一便携防水收纳袋可悬挂大容量运动鞋拖鞋家用外用分装袋';
  const existingRecords = [
    { record_id: 'recvrzu9OaXx9Q', fields: {
      '📡 商品全称': title + ' [拆分]',
      '平台所属账号': '微信小店-【5820】',
      '手动传输状态': '已打单',
    }},
    { record_id: 'recvrzu9OaMAIN', fields: {
      '📡 商品全称': title,
      '平台所属账号': '微信小店-【5820】',
      '手动传输状态': '已打单',
    }},
  ];
  
  const lookup = ctx.buildLookupMaps(existingRecords);
  const result = ctx.matchRecord('', title, lookup, '微信小店-【5820】', false);
  
  assert.ok(result, 'Should match');
  assert.equal(result.rec.record_id, 'recvrzu9OaMAIN', 'Should prefer non-split main record');
});

test('5820 dedup: does not create duplicate when30 existing records exist', () => {
  const ctx = makeMatchContext();
  
  const existingRecords = [];
  for (let i = 0; i < 30; i++) {
    existingRecords.push({
      record_id: `rec_${String(i).padStart(3, '0')}`,
      fields: {
        '📡 商品全称': '【好物推荐】电动车震动感应彩灯防追尾',
        '商品 🆔': '10001264175580',
        '平台所属账号': '微信小店-【5820】',
        '手动传输状态': '已打单',
      },
    });
  }
  
  const lookup = ctx.buildLookupMaps(existingRecords);
  const result = ctx.matchRecord('10001264175580', '【好物推荐】电动车震动感应彩灯防追尾', lookup, '微信小店-【5820】', false);
  
  assert.ok(result, 'Should match an existing record');
  assert.ok(result.rec.record_id.startsWith('rec_'), 'Should match existing, not create new');
});

test('5820 dedup: does not cross platform boundaries', () => {
  const ctx = makeMatchContext();
  
  const existingRecords = [
    { record_id: 'rec_5820', fields: {
      '📡 商品全称': '电动车震动感应彩灯防追尾',
      '平台所属账号': '微信小店-【5820】',
      '手动传输状态': '已打单',
    }},
    { record_id: 'rec_7207', fields: {
      '📡 商品全称': '电动车震动感应彩灯防追尾',
      '平台所属账号': '微信小店-【7207】',
      '手动传输状态': '已打单',
    }},
  ];
  
  const lookup = ctx.buildLookupMaps(existingRecords);
  const result = ctx.matchRecord('', '电动车震动感应彩灯防追尾', lookup, '微信小店-【5820】', false);
  
  assert.ok(result, 'Should match');
  assert.equal(result.rec.record_id, 'rec_5820', 'Should match same platform');
});
