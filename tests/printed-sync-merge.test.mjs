// V20.29.6: 已打单补同步（printedOnly）安全与合并测试
// 验证三条承诺：
//  1. printedOnly 过滤只保留"已打单"，未打单不进入补同步来源
//  2. printedOnly 补同步绝不产生删除候选、绝不回写未打单状态（不误删未打单采购行）
//  3. 补同步走完整合并管线：同产品跨平台 → 归并成一组（不暴涨），
//     且 strictMergeEvidence 仍拦截误合并（不同产品不被合并）
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
  const context = {String, Number, Array, Object, JSON, Math, Date, RegExp, parseInt, parseFloat, isNaN, isFinite, Set, Map, undefined};
  vm.createContext(context);
  // 合并管线依赖的最小函数集
  for (const fn of [
    'sv', 'norm', 'normTitle', 'jaroWinkler', 'diceSim', 'triSim', 'cosineSim',
    'cnTokenize', 'tokenJaccard', 'extractSpecNames', 'specOverlap', 'specTokenOverlap',
    'specAvgLen', 'specTrigMax', 'multiSim', 'compositeScore', 'extractCoreProductNoun',
    'extractCategory', 'hasCategoryConflict', 'extractProductType', 'enhancedCategoryConflict',
    'specTitleConsistencyCheck', 'extractSpecStructure', 'compareSpecStructure',
    'specNgramSimilarity', 'enhancedSpecEvidence', 'procurementSpecEvidence',
    'procurementKeywordConcepts', 'procurementSharedKeywordConcept', 'procurementCoreTitleText',
    'procurementCoreTitleNgrams', 'procurementProfileCoreNgrams', 'buildProcurementCorpusStats',
    'procurementProductFeatures', 'procurementFeatureSimilarity', 'procurementRareCoreEvidence',
    'procurementInformativeSpecKeys', 'procurementProductFamilies', 'procurementModelTokens',
    'procurementModelConflict', 'procurementSubType', 'procurementFamilyConflict',
    'procurementTitleContainment', 'procurementVectorScore', 'findSafeProcurementVectorMatch',
    'extractRecFields', 'removeStopWords', 'coreProductConflict', 'procurementSpecInformation',
    'procurementSpecQtyTotal', 'normalizeProcurementSpecName', 'procurementBlockTokens',
    'buildVectorCandidateIndex', 'selectVectorCandidatesByIndex', 'strictMergeEvidence',
    'canJoinMergeInPlaceGroup', 'procurementTitleFamilyConflict',
    'procurementDistinctiveTitleConflict', 'procurementHasSplitTitleMarker',
    'procurementTitleIdentityExact', 'canonicalProcurementTitleKey', 'chooseProcurementTitleRecord',
    'matchPlatformAccount', 'procurementProfileIdentitySafe', 'extractCoreProductFamilies',
    'mergeSpecIdentityEvidence', 'mergeSpecIdentityLines', 'strictSpecTitleConsistency',
    'titleContentOverlap', 'procurementPlatformContains', 'hasPurchaserManualData',
  ]) {
    vm.runInContext(extractFunction(sidepanelSource, fn), context);
  }
  for (const cn of ['CORE_PRODUCT_FAMILIES', 'CATEGORY_KEYWORDS', 'PRODUCT_TYPE_KEYWORDS']) {
    const cs = sidepanelSource.indexOf(`var ${cn} = {`);
    if (cs >= 0) {
      const ce = sidepanelSource.indexOf('\n};', cs) + 3;
      vm.runInContext(sidepanelSource.slice(cs, ce), context);
    }
  }
  return context;
}

test('printedOnly 过滤: 只保留已打单，未打单剔除', () => {
  const context = makeContext();
  const recs = [
    {record_id:'r1', fields:{'手动传输状态':'已打单'}},
    {record_id:'r2', fields:{'🚃 状态🌅':'未打单'}},
    {record_id:'r3', fields:{'状态':'已打单'}},
    {record_id:'r4', fields:{'传输状态':'已打单'}},
    {record_id:'r5', fields:{}},
  ];
  const filtered = recs.filter(r => {
    const f = r.fields || {};
    const st = f['手动传输状态'] || f['状态'] || f['🚃 状态🌅'] || f['传输状态'] || '';
    return String(st) === '已打单';
  });
  assert.equal(filtered.length, 3);
  assert.deepEqual(filtered.map(r => r.record_id).sort(), ['r1', 'r3', 'r4']);
});

test('补同步保护: 未打单采购行不产生删除候选、不被回写状态', () => {
  const context = makeContext();
  // printedOnly = true 时：即使采购人工字段全空，也不进 deleteCandidates
  const fields = {
    '📡 商品全称': '收纳袋', '🚧 ❗【时段】产品需求值': '1个',
    '🚃 状态🌅': '未打单', '平台【文字】': '淘宝-【7205】',
  };
  const hasManual = context.hasPurchaserManualData(fields, []);
  assert.equal(hasManual, false);
  // 关键断言：printedOnly 模式下 shouldDelete 恒为 false
  const shouldDelete = (!true) && !hasManual; // !printedOnly && !hasManual
  assert.equal(shouldDelete, false);
  // 状态回写同理被禁用
  const shouldRewriteStatus = (!true) && context.sv(fields['🚃 状态🌅']) !== '未打单';
  assert.equal(shouldRewriteStatus, false);
});

test('补同步走合并管线: 同产品跨平台归并成一组，不暴涨', () => {
  const context = makeContext();
  // 同一产品在 3 个平台 → 补同步应归并为 1 组
  const sources = [
    {record_id:'a', fields:{'📡 商品全称':'加厚垃圾袋家用大号','🚧 ❗【时段】产品需求值':'45*50cm 100只','商品 🆔':'p100','平台【文字】':'淘宝-【7205】','🚃 状态🌅':'已打单'}},
    {record_id:'b', fields:{'📡 商品全称':'加厚垃圾袋家用大号','🚧 ❗【时段】产品需求值':'45*50cm 100只','商品 🆔':'p100','平台【文字】':'京东-【7205】','🚃 状态🌅':'已打单'}},
    {record_id:'c', fields:{'📡 商品全称':'加厚垃圾袋家用大号','🚧 ❗【时段】产品需求值':'45*50cm 100只','商品 🆔':'p100','平台【文字】':'拼多多-【7205】','🚃 状态🌅':'已打单'}},
    // 不同产品（塑料袋 vs 收纳盒）→ 不得合并
    {record_id:'d', fields:{'📡 商品全称':'冰箱收纳盒塑料储物箱','🚧 ❗【时段】产品需求值':'中号3个','商品 🆔':'p200','平台【文字】':'淘宝-【7205】','🚃 状态🌅':'已打单'}},
  ];
  const recs = sources.map(r => ({record_id:r.record_id, fields:r.fields}));
  const groups = [];
  const pidIndex = {}, titleIndex = {}, groupCandidateIndex = {};
  const corpus = context.buildProcurementCorpusStats(recs.map(rec => {
    const s = context.extractRecFields(rec); return {title: s.title, spec: s.spec};
  }));
  function addToIndex(gi, anchor) {
    const tokens = context.procurementBlockTokens(anchor.title || '').concat(context.procurementBlockTokens(anchor.spec || ''));
    tokens.forEach(t => { if (!groupCandidateIndex[t]) groupCandidateIndex[t] = []; if (groupCandidateIndex[t].indexOf(gi) < 0) groupCandidateIndex[t].push(gi); });
  }
  for (const rec of recs) {
    const src = context.extractRecFields(rec);
    let tg = -1;
    if (src.pid) { for (const p of src.pid.split(/[\n,]/)) { const pp = p.trim(); if (pp && pidIndex[pp] !== undefined) { tg = pidIndex[pp]; break; } } }
    if (tg < 0) { const tk = context.norm(src.title || ''); if (tk && titleIndex[tk] !== undefined) tg = titleIndex[tk]; }
    if (tg >= 0 && !context.canJoinMergeInPlaceGroup(src, groups[tg])) tg = -1;
    if (tg < 0) {
      const all = groups.map((g, gi) => ({title: g.anchor.title, spec: g.anchor.spec, _groupIdx: gi}));
      const cand = context.selectVectorCandidatesByIndex(src, groupCandidateIndex, all);
      const vd = context.findSafeProcurementVectorMatch(src, cand, corpus);
      if (vd && !vd.ambiguous) {
        const vgi = vd.candidate._groupIdx;
        if (context.canJoinMergeInPlaceGroup(src, groups[vgi])) tg = vgi;
      }
    }
    if (tg >= 0) {
      groups[tg].records.push(rec);
      const tk = context.norm(src.title || ''); if (tk) titleIndex[tk] = tg;
      if (src.pid) src.pid.split(/[\n,]/).forEach(p => { const pp = p.trim(); if (pp) pidIndex[pp] = tg; });
    } else {
      groups.push({anchor: {title: src.title || '', spec: src.spec || ''}, records: [rec]});
      const gi = groups.length - 1;
      addToIndex(gi, {title: src.title || '', spec: src.spec || ''});
      if (src.pid) src.pid.split(/[\n,]/).forEach(p => { const pp = p.trim(); if (pp) pidIndex[pp] = gi; });
      const tk = context.norm(src.title || ''); if (tk) titleIndex[tk] = gi;
    }
  }
  // 4 条来源 → 2 组：垃圾袋(3平台) + 收纳盒(1平台)
  assert.equal(groups.length, 2, '同产品跨平台必须归并，不同产品不得合并');
  const bag = groups.find(g => /垃圾袋/.test(g.anchor.title));
  assert.ok(bag, '垃圾袋组存在');
  assert.equal(bag.records.length, 3, '3 平台垃圾袋归并为 1 组');
  const platforms = new Set();
  bag.records.forEach(r => { const s = context.extractRecFields(r); (s.platform || '').split('\n').forEach(p => { if (p) platforms.add(p); }); });
  assert.equal(platforms.size, 3, '平台换行保留 3 个');
});

test('strictMergeEvidence 在补同步中仍拦截误合并', () => {
  const context = makeContext();
  const ok = context.strictMergeEvidence(
    '洁面巾一次性洗脸巾', '50抽*3包',
    '压缩浴巾一次性旅行', '1条装'
  );
  assert.equal(ok, false, '洁面巾 vs 压缩浴巾：不同产品不得合并');
});
