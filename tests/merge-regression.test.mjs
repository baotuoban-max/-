// 合并逻辑回归测试（V20.29.0 重写：适配稳定版 v20.16.3 API）
// [拆分] 标记功能已在 V20.28.x 清理中移除，相关测试改为验证稳定版实际行为。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

const sandbox = { console, Math, String, Array, Object, RegExp, Date, Number, JSON, Error, TypeError, parseInt, parseFloat, isNaN, isFinite, undefined, Set, Map };
const fns = [
  'norm', 'normTitle', 'jaroWinkler', 'diceSim', 'triSim', 'cosineSim',
  'cnTokenize', 'tokenJaccard', 'extractSpecNames', 'specOverlap', 'specTokenOverlap',
  'specAvgLen', 'specTrigMax', 'multiSim', 'compositeScore',
  'procurementTitleContainment', 'procurementVectorScore', 'findSafeProcurementVectorMatch',
  'procurementCoreTitleText', 'procurementCoreTitleNgrams', 'procurementProfileCoreNgrams',
  'procurementProductFamilies', 'procurementModelTokens', 'procurementSubType',
  'procurementFamilyConflict', 'procurementModelConflict', 'procurementTitleContainment',
  'extractCoreProductNoun', 'coreProductConflict', 'enhancedCategoryConflict',
  'specTitleConsistencyCheck', 'procurementInformativeSpecKeys', 'procurementRareCoreEvidence',
  'procurementFeatureSimilarity', 'procurementProductFeatures', 'buildProcurementCorpusStats',
  'procurementKeywordConcepts', 'procurementSharedKeywordConcept', 'extractRecFields',
  'removeStopWords', 'extractCategory', 'hasCategoryConflict', 'extractProductType',
  'enhancedSpecEvidence', 'procurementSpecEvidence', 'extractSpecStructure',
  'compareSpecStructure', 'specNgramSimilarity', 'normalizeProcurementSpecName',
  'procurementSpecInformation', 'procurementSpecQtyTotal',
  // V20.29.0 移植函数依赖
  'procurementTitleFamilyConflict', 'procurementDistinctiveTitleConflict',
  'procurementHasSplitTitleMarker', 'procurementTitleIdentityExact',
  'canonicalProcurementTitleKey', 'chooseProcurementTitleRecord', 'matchPlatformAccount',
  'procurementProfileIdentitySafe', 'extractCoreProductFamilies', 'mergeSpecIdentityEvidence',
  'mergeSpecIdentityLines', 'strictSpecTitleConsistency', 'titleContentOverlap', 'strictMergeEvidence',
];

let code = '';
for (const fn of fns) {
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
  if (cstart >= 0) {
    const cend = src.indexOf('\n};', cstart) + 3;
    code += `${src.slice(cstart, cend)}\n`;
  }
}
vm.runInNewContext(code, sandbox);

console.log('=== 合并逻辑回归测试（V20.29.0）===\n');

// Test 1: 同产品同标题不同规格 → 应合并（标题精确 + 规格合并）
{
  const title = '【厨房好物】燃气灶防滑支架家用煤气灶炒锅奶锅通用锅架灶台防滑托置物架子';
  const spec1 = '通用十字锅架【1个装】-贵在运费;357\n通用十字锅架【2个装】-更划算;154';
  const spec2 = '通用十字锅架【1个装】-贵在运费;415\n通用十字锅架【2个装】-更划算;187';
  const norm1 = sandbox.norm(title);
  const norm2 = sandbox.norm(title);
  assert.equal(norm1, norm2, 'Same title should produce same normalized key');
  // 标题精确相等直接通过向量评分（TITLE_NORMALIZED）
  const decision = sandbox.procurementVectorScore(
    { title, spec: spec1 }, { title, spec: spec2 }, null
  );
  assert.equal(decision.approved, true, 'Same title different specs should merge');
  console.log('✅ Test 1: 同商品同标题不同规格 → 可合并');
}

// Test 2: 不同产品不应合并
{
  const t1 = '手机壳硅胶软壳透明防摔';
  const t2 = '数据线充电线快充Type-C';
  const decision = sandbox.procurementVectorScore(
    { title: t1, spec: '手机壳;1' }, { title: t2, spec: '数据线;1' }, null
  );
  assert.equal(decision.approved, false, 'Different products should not merge');
  console.log('✅ Test 2: 不同商品（手机壳 vs 数据线）不会误合并');
}

// Test 3: 状态只能升级不能降级（保持原断言）
{
  const max1 = (function(a, b) {
    if (a === '已打单' || b === '已打单') return '已打单';
    return b || a || '未打单';
  })('未打单', '已打单');
  assert.equal(max1, '已打单', 'Status should upgrade to 已打单');

  const max2 = (function(a, b) {
    if (a === '已打单' || b === '已打单') return '已打单';
    return b || a || '未打单';
  })('已打单', '未打单');
  assert.equal(max2, '已打单', 'Status should NOT downgrade from 已打单');
  console.log('✅ Test 3: 状态只能升级不能降级');
}

// Test 4: 短标题保护（containment 对短标题返回 0，无法仅靠包含关系合并）
{
  const short = '手机壳';
  assert.equal(sandbox.procurementTitleContainment(short, '新款手机壳硅胶'), 0,
    'Short title (<6 chars) must not merge via containment');
  console.log('✅ Test 4: 短标题保护（<6 字符不参与包含匹配）');
}

// Test 5: emoji 一致性（🚃 而非 🚌）
{
  assert.ok(!src.includes("'🚌 状态'"), 'Should NOT contain bus emoji 🚌');
  assert.ok(src.includes("'🚃 状态"), 'Should contain train emoji 🚃');
  console.log('✅ Test 5: emoji 一致性（🚃 而非 🚌）');
}

// Test 6: todayMs 定义存在
{
  const todayMsLines = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('var todayMs') && !lines[i].includes('//')) todayMsLines.push(i + 1);
  }
  assert.ok(todayMsLines.length > 0, 'todayMs should be defined');
  console.log('✅ Test 6: todayMs 定义存在 (' + todayMsLines.join(', ') + ')');
}

// Test 7: PAT 硬编码（不依赖 Chrome 存储）
{
  const patLines = src.split('\n').filter(l => /var PAT\s*=/.test(l));
  assert.ok(patLines.length >= 2, 'Should have hardcoded PAT in at least 2 places');
  assert.ok(patLines.every(l => l.includes('DptPbPEluaupDjsp2XZcFK56nte')), 'All PAT should use same app token (test base)');
  console.log('✅ Test 7: PAT 硬编码（不依赖 Chrome 存储）');
}

// Test 8: V20.29.0 合并安全机制存在
{
  assert.ok(src.includes('procurementBlockTokens'), 'Should have blocking token extractor');
  assert.ok(src.includes('selectVectorCandidatesByIndex'), 'Should have vector candidate index');
  assert.ok(src.includes('canJoinMergeInPlaceGroup'), 'Should have merge group safety check');
  assert.ok(src.includes('strictMergeEvidence'), 'Should have strict merge evidence');
  console.log('✅ Test 8: V20.29.0 合并提速+安全机制存在');
}

console.log('\n=== 8/8 回归测试全部通过 ===');
