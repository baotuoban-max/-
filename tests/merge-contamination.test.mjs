// V20.29.2 规格交叉污染回归测试
// 基于用户提供的真实错误合并案例：
// 1. 不同产品不得因共享泛家族/泛词被合并（冰箱收纳盒 vs 磁吸置物架）
// 2. 单条记录的规格字段混入其他产品规格时，交叉污染检测必须捕获
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

function extractFn(source, name) {
  const idx = source.indexOf(`function ${name}(`);
  if (idx < 0) return null;
  const brace = source.indexOf('{', idx);
  let depth = 0;
  let quote = '';
  let end = -1;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return source.slice(idx, end);
}

const need = [
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
  'procurementTitleFamilyConflict', 'procurementDistinctiveTitleConflict',
  'procurementHasSplitTitleMarker', 'procurementTitleIdentityExact', 'canonicalProcurementTitleKey',
  'procurementProfileIdentitySafe', 'extractCoreProductFamilies', 'mergeSpecIdentityEvidence',
  'mergeSpecIdentityLines', 'strictSpecTitleConsistency', 'titleContentOverlap',
  'strictMergeEvidence', 'canJoinMergeInPlaceGroup', 'specExtractFamilies',
  'checkSpecCrossContamination', 'extractSpecLineProductName', 'parseSpecLine',
  'parseSpecStructure',
];

let code = '';
for (const fn of need) {
  const f = extractFn(src, fn);
  if (f) code += `${f}\n`;
}
const aw = src.indexOf('var SPEC_ATTR_WORDS');
if (aw >= 0) { const aend = src.indexOf(';', aw) + 1; code += `${src.slice(aw, aend)}\n`; }
for (const cn of ['CORE_PRODUCT_FAMILIES', 'CATEGORY_KEYWORDS', 'PRODUCT_TYPE_KEYWORDS']) {
  const cs = src.indexOf(`var ${cn} = {`);
  if (cs >= 0) {
    const ce = src.indexOf('\n};', cs) + 3;
    code += `${src.slice(cs, ce)}\n`;
  }
}
const sandbox = {
  console: { log() {}, warn() {}, error() {} }, Math, String, Array, Object, RegExp,
  Date, Number, JSON, parseInt, parseFloat, isNaN, isFinite, undefined, Set, Map,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

test('不同产品不得合并：冰箱侧门收纳盒 vs 磁吸置物架', () => {
  const a = { title: '【超值！到手6个】冰箱侧门收纳盒水果蔬菜保鲜盒厨房杂物收纳储物盒', spec: '重磅福利：【6个装】冰箱收纳盒/冷藏冷冻都可用;1' };
  const b = { title: '厨房磁吸置物架冰箱侧调料品收纳盒神器保鲜膜收纳杂物侧面收纳筐', spec: '奶白色;大号;34\n枪灰色;大号;23' };
  const d = sandbox.procurementVectorScore(a, b, null);
  const se = sandbox.strictMergeEvidence(a.title, a.spec, b.title, b.spec);
  assert.equal(d.approved, false, '冰箱收纳盒与磁吸置物架是不同产品，向量评分必须拒绝');
  assert.equal(se, false, '严格证据必须拒绝');
});

test('不同产品不得合并：车窗储物盒 vs 扶手箱增高垫', () => {
  const a = { title: '汽车车窗储物盒车载收纳袋水杯架手机放置侧面置物盒多功能WJ', spec: '【车窗边水杯盒】理想橙;1' };
  const b = { title: '汽车扶手箱增高垫车载纸巾盒中央多功能储物盒水杯手机卡片收纳盒', spec: '长34*宽18.5*高5厘米;随机颜色（含纸巾）;2' };
  assert.equal(sandbox.strictMergeEvidence(a.title, a.spec, b.title, b.spec), false);
});

test('不同产品不得合并：洁面巾 vs 压缩浴巾（家族表细化后）', () => {
  const a = { title: '加大加厚洁面巾一次性洗脸巾柔软亲肤', spec: '加大加厚洁面巾【1包】体验款;1' };
  const b = { title: '压缩浴巾旅行装一次性加厚', spec: '旅行装(3条60*120压缩浴巾);60' };
  assert.equal(sandbox.strictMergeEvidence(a.title, a.spec, b.title, b.spec), false);
});

test('合理合并保留：水槽过滤网变体', () => {
  const a = { title: '不锈钢盖板厨房水槽过滤网下水漏水塞洗碗池通用款弹跳好物XW新', spec: '【不锈钢盖板升级版】1个;1' };
  const b = { title: '不锈钢厨房水槽过滤网洗菜盆漏水塞洗碗池款水槽弹跳芯下水器-YF', spec: '不锈钢水槽弹跳芯【加大滤网】1个装;3' };
  assert.equal(sandbox.strictMergeEvidence(a.title, a.spec, b.title, b.spec), true);
});

test('合理合并保留：丁腈手套变体', () => {
  const a = { title: '萌宠小狗丁腈材质家用防滑耐磨家用劳保用品防护手套劳保用品CJ', spec: '' };
  const b = { title: '【买一送一】萌宠小狗丁腈材质防滑耐磨加厚防护手套劳保手套Y', spec: '' };
  assert.equal(sandbox.strictMergeEvidence(a.title, a.spec, b.title, b.spec), true);
});

test('交叉污染检测必须捕获：洁面巾规格混入压缩浴巾', () => {
  const r = sandbox.checkSpecCrossContamination(
    '加大加厚洁面巾一次性洗脸巾',
    '加大加厚洁面巾【1包】体验款;1\n旅行装(3条60*120压缩浴巾);60',
  );
  assert.equal(r.contaminated, true, '洁面巾规格混入压缩浴巾必须被检测');
});

test('交叉污染检测必须捕获：刮刀规格混入螺丝刀套装', () => {
  const r = sandbox.checkSpecCrossContamination(
    '多功能刮刀厨房清洁铲刀去油',
    '回纹路刮刀【1把】送收纳盒;5\n【多功能螺丝刀套装】铝合金手柄+24个批头+收纳盒;7',
  );
  assert.equal(r.contaminated, true, '刮刀规格混入螺丝刀套装必须被检测');
});

test('交叉污染检测必须捕获：鸭嘴夹规格混入发卡', () => {
  const r = sandbox.checkSpecCrossContamination(
    '水钻鸭嘴夹后脑勺夹子',
    '小香风蝴蝶结鸭嘴夹【2个装】;1\n气质碎钻蝴蝶结发卡【1个装】;3',
  );
  assert.equal(r.contaminated, true, '鸭嘴夹规格混入发卡必须被检测');
});

test('交叉污染检测不误报：同产品变体规格', () => {
  const r = sandbox.checkSpecCrossContamination(
    '加大加厚洁面巾一次性洗脸巾',
    '加大加厚洁面巾【1包】体验款;1\n加大加厚洁面巾【2包】优惠款;1',
  );
  assert.equal(r.contaminated, false, '同产品变体规格不应误报污染');
});

test('交叉污染检测不误报：削发梳颜色变体', () => {
  const r = sandbox.checkSpecCrossContamination(
    '成人打薄梳削发梳子',
    '双面削发梳粉色【1把+10刀片】;16\n双面削发梳黑色【1把+10刀片】;15',
  );
  assert.equal(r.contaminated, false, '削发梳颜色变体不应误报污染');
});
