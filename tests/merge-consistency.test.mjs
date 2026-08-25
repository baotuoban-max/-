// V20.29.0 合并一致性回归测试
// 验证：
// 1. blocking 索引加速后，合并结果与全量比较完全一致（防漏合并回归）
// 2. 防误合并：不同产品不会合并到一起
// 3. canJoinMergeInPlaceGroup 阻止传递链污染
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

const need = [
  'norm', 'jaroWinkler', 'diceSim', 'triSim', 'cosineSim', 'cnTokenize', 'tokenJaccard',
  'extractSpecNames', 'specOverlap', 'specTokenOverlap', 'specAvgLen', 'specTrigMax',
  'multiSim', 'compositeScore', 'extractCoreProductNoun', 'extractCategory',
  'hasCategoryConflict', 'extractProductType', 'enhancedCategoryConflict',
  'specTitleConsistencyCheck', 'extractSpecStructure', 'compareSpecStructure',
  'specNgramSimilarity', 'enhancedSpecEvidence', 'procurementSpecEvidence',
  'procurementKeywordConcepts', 'procurementSharedKeywordConcept',
  'procurementCoreTitleText', 'procurementCoreTitleNgrams', 'procurementProfileCoreNgrams',
  'buildProcurementCorpusStats', 'procurementProductFeatures', 'procurementFeatureSimilarity',
  'procurementRareCoreEvidence', 'procurementInformativeSpecKeys', 'procurementProductFamilies',
  'procurementModelTokens', 'procurementModelConflict', 'procurementSubType',
  'procurementFamilyConflict', 'procurementTitleContainment', 'procurementVectorScore',
  'findSafeProcurementVectorMatch', 'extractRecFields', 'removeStopWords',
  'coreProductConflict', 'procurementSpecInformation', 'procurementSpecQtyTotal',
  'normalizeProcurementSpecName', 'procurementBlockTokens', 'buildVectorCandidateIndex',
  'selectVectorCandidatesByIndex', 'strictMergeEvidence', 'canJoinMergeInPlaceGroup',
  // V20.29.0 移植函数依赖
  'procurementTitleFamilyConflict', 'procurementDistinctiveTitleConflict',
  'procurementHasSplitTitleMarker', 'procurementTitleIdentityExact',
  'canonicalProcurementTitleKey', 'chooseProcurementTitleRecord', 'matchPlatformAccount',
  'procurementProfileIdentitySafe', 'extractCoreProductFamilies', 'mergeSpecIdentityEvidence',
  'mergeSpecIdentityLines', 'strictSpecTitleConsistency', 'titleContentOverlap',
];

let code = '';
for (const fn of need) {
  const start = src.indexOf(`function ${fn}(`);
  if (start < 0) continue;
  const brace = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  code += `${src.slice(start, end)}\n`;
}
for (const constName of ['CORE_PRODUCT_FAMILIES', 'CATEGORY_KEYWORDS', 'PRODUCT_TYPE_KEYWORDS']) {
  const cstart = src.indexOf(`var ${constName} = `);
  const cend = src.indexOf('\n};', cstart) + 3;
  if (cstart >= 0) code += `${src.slice(cstart, cend)}\n`;
}

const sandbox = {
  console, Math, String, Array, Object, RegExp, Date, Number, JSON,
  parseInt, parseFloat, isNaN, isFinite, undefined, Set, Map,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

// 合并分组核心（与 mergeInPlace Step 3 相同逻辑）
function runMerge(records, useBlocking) {
  const groups = [];
  const pidIndex = {};
  const titleIndex = {};
  const groupCandidateIndex = {};
  const corpus = sandbox.buildProcurementCorpusStats(
    records.map((r) => ({ title: r.title, spec: r.spec }))
  );
  function addToIndex(gi, anchor) {
    const tokens = sandbox.procurementBlockTokens(anchor.title || '')
      .concat(sandbox.procurementBlockTokens(anchor.spec || ''));
    tokens.forEach((t) => {
      if (!groupCandidateIndex[t]) groupCandidateIndex[t] = [];
      if (groupCandidateIndex[t].indexOf(gi) < 0) groupCandidateIndex[t].push(gi);
    });
  }
  for (const rec of records) {
    let tg = -1;
    if (rec.pid) {
      for (const p of rec.pid.split(/[,，\n]/)) {
        const pp = p.trim();
        if (pp && pidIndex[pp] !== undefined) {
          tg = pidIndex[pp];
          break;
        }
      }
    }
    if (tg < 0) {
      const tk = sandbox.norm(rec.title || '');
      if (tk && titleIndex[tk] !== undefined) tg = titleIndex[tk];
    }
    if (tg < 0) {
      const allCandidates = groups.map((g, gi) => ({ title: g.anchor.title, spec: g.anchor.spec, _groupIdx: gi }));
      const candidates = useBlocking
        ? sandbox.selectVectorCandidatesByIndex(rec, groupCandidateIndex, allCandidates)
        : allCandidates;
      const vd = sandbox.findSafeProcurementVectorMatch(rec, candidates, corpus);
      if (vd && !vd.ambiguous) tg = vd.candidate._groupIdx;
    }
    if (tg >= 0) {
      groups[tg].records.push(rec);
      const tk = sandbox.norm(rec.title || '');
      if (tk) titleIndex[tk] = tg;
      rec.pid.split(/[,，\n]/).forEach((p) => {
        const pp = p.trim();
        if (pp) pidIndex[pp] = tg;
      });
    } else {
      groups.push({ anchor: { title: rec.title, spec: rec.spec }, records: [rec] });
      const gi = groups.length - 1;
      addToIndex(gi, { title: rec.title, spec: rec.spec });
      rec.pid.split(/[,，\n]/).forEach((p) => {
        const pp = p.trim();
        if (pp) pidIndex[pp] = gi;
      });
      const tk = sandbox.norm(rec.title || '');
      if (tk) titleIndex[tk] = gi;
    }
  }
  return groups;
}

function summarize(groups) {
  return groups.map((g) => ({
    anchor: g.anchor.title,
    count: g.records.length,
  })).sort((a, b) => a.anchor.localeCompare(b.anchor));
}

// 测试数据：同产品变体（应合并）+ 不同产品（不应合并）+ 通用词干扰
const testData = [
  // 产品1：手机支架（变体标题）
  { title: '2026新款皮纹可吸桌面磁吸手机支架车载导航', spec: '玄武黑【可吸皮纹/玻璃】;42\n月光白【可吸皮纹/玻璃】;3', pid: 'P1001' },
  { title: '新款皮纹磁吸手机支架 可吸桌面车载导航', spec: '玄武黑【可吸皮纹/玻璃】;8\n月光白【可吸皮纹/玻璃】;2', pid: 'P1002' },
  { title: '手机支架车载导航磁吸可吸桌面', spec: '玄武黑【可吸皮纹/玻璃】;5', pid: 'P1003' },
  // 产品2：遥控器收纳盒（不应与手机支架合并）
  { title: '【9.9包邮】粘贴遥控器收纳盒壁挂床头手机空调遥控收纳神器F', spec: '遥控器收纳盒;1', pid: 'P2001' },
  { title: '遥控器收纳盒壁挂式粘贴免打孔', spec: '遥控器收纳盒;2', pid: 'P2002' },
  // 产品3：游泳包（不应与收纳袋合并）
  { title: '游泳包防水收纳袋大容量健身湿衣服束口袋男女干湿分离', spec: '游泳包;1', pid: 'P3001' },
  // 产品4：真空收纳袋（不同品类）
  { title: '【升级免抽气】换季真空收纳袋加大立体款压缩袋被褥', spec: '真空压缩袋;1', pid: 'P4001' },
  // 产品5：空调罩（FEATURE_MATCH 合法合并）
  { title: '空调外机保护罩防雨防晒', spec: '空调外机保护罩;1', pid: 'P5001' },
  { title: '空调外机防晒罩防雨', spec: '空调外机防晒罩;1', pid: 'P5002' },
];

test('blocking 索引合并结果与全量比较完全一致', () => {
  const full = runMerge(testData, false);
  const blocked = runMerge(testData, true);
  assert.deepEqual(summarize(blocked), summarize(full), 'blocking 必须不改变合并结果');
  assert.ok(full.length >= 4, `应保留至少 4 组不同产品（实际 ${full.length} 组）`);
});

test('blocking 索引不把不同产品合并（手机支架 vs 遥控器收纳盒 vs 收纳袋）', () => {
  const blocked = runMerge(testData, true);
  const anchors = blocked.map((g) => g.anchor.title);
  // 手机支架组应只有手机支架
  const phoneHolderGroup = blocked.find((g) => g.anchor.title.includes('手机支架')) || blocked.find((g) => g.anchor.title.includes('磁吸'));
  assert.ok(phoneHolderGroup, '应存在手机支架组');
  const holderRecords = phoneHolderGroup.records.map((r) => r.title).join(' | ');
  assert.ok(holderRecords.includes('手机支架') || holderRecords.includes('磁吸'), '手机支架组应包含手机支架产品');
  assert.ok(!holderRecords.includes('遥控器收纳盒'), '遥控器收纳盒不应并入手机支架组');
  assert.ok(!holderRecords.includes('游泳包'), '游泳包不应并入手机支架组');
  assert.ok(!holderRecords.includes('真空收纳袋'), '真空收纳袋不应并入手机支架组');
});

test('同产品变体应合并（皮纹磁吸手机支架变体）', () => {
  const blocked = runMerge(testData, true);
  const group = blocked.find((g) => g.records.some((r) => r.title.includes('磁吸')));
  assert.ok(group, '应存在手机支架合并组');
  assert.ok(group.records.length >= 2, `手机支架变体应合并（实际 ${group.records.length} 条）`);
});

test('空调罩 FEATURE_MATCH 合法合并仍生效', () => {
  const blocked = runMerge(testData, true);
  const acGroup = blocked.find((g) => g.anchor.title.includes('空调外机'));
  assert.ok(acGroup, '空调外机罩应存在');
  assert.ok(acGroup.records.length >= 2, '空调外机防晒罩与保护罩应合法合并');
});

test('canJoinMergeInPlaceGroup 阻止传递链污染', () => {
  // A 与 B 相似（可合并），B 与 C 相似，但 A 与 C 不同 —— 不能把 C 并入 A 组
  const a = { title: '手机支架车载导航磁吸可吸桌面', spec: '玄武黑;1' };
  const b = { title: '手机支架车载磁吸导航', spec: '玄武黑;1' };
  const c = { title: '手机支架收纳盒桌面置物架', spec: '收纳盒;1' };
  const group = {
    anchor: { title: a.title, spec: a.spec },
    records: [{ fields: { '📡 商品全称': b.title, '🚧 ❗【时段】产品需求值': b.spec } }],
  };
  // A 与 B 应能合并
  assert.equal(sandbox.strictMergeEvidence(a.title, a.spec, b.title, b.spec), true, 'A-B 应通过严格证据');
  // C 不应能并入 A+B 组（与任一成员证据不足）
  assert.equal(
    sandbox.canJoinMergeInPlaceGroup(c, group),
    false,
    '传递链第三产品不得并入（与锚点或成员证据不足）'
  );
});
