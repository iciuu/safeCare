# 字段字典与抽取 Schema 草案

配套 [`PLAN.md`](./PLAN.md)。四类险种：**医疗险 / 重疾险 / 意外险 / 寿险**。

这一份是「抽取契约」：模型输出什么、什么必须带引用、什么算抽取失败。先定口径，再写代码。

## 0. 通用约定

### 0.1 字段信封

所有叶子字段都用同一个信封，禁止裸值：

```ts
type Field<T> = {
  value: T | null;                 // 抽不到就是 null，不要猜
  clause_id: string | null;        // 必须指向已入库的 clause（S2 产物）
  quote: string | null;            // 支撑该值的原文片段，程序需能反查到
  confidence: number;              // 0–1
  review: 'ok' | 'needs_review' | 'conflict';
};
```

硬规则：

1. `value !== null` ⇒ `clause_id` 与 `quote` 都不得为 null（入库前校验，不过则强制 `needs_review`）。
2. `quote` 必须在对应 `clause.text` 中可定位（归一化去空白后模糊匹配 ≥ 0.9），否则 `needs_review`。
3. 同字段在多个条款出现且不一致 ⇒ 全部保留，`review='conflict'`，交人工。
4. 金额一律人民币**元**的整数；比例一律 0–1 小数；天数一律整数；日期 `YYYY-MM-DD`。
5. 区间/分档不要压成单值，用 `tiers`。

### 0.2 常见表述归一表

抽取前先做术语归一，能显著降低「同一件事抽成两个字段」的概率：

| 归一字段 | 合同里的写法 |
|---|---|
| 保险金额 / 限额 | 保险金额、基本保险金额、年度限额、责任限额、最高给付限额、赔偿限额 |
| 免赔额 | 年免赔额、年度累计免赔额、绝对免赔额、每次事故免赔额、家庭共享免赔额 |
| 赔付比例 | 给付比例、报销比例、赔付比率、补偿比例 |
| 等待期 | 观察期、免责期、等待期间 |
| 责任免除 | 除外责任、不保事项、我们不承担保险责任的情形 |
| 医院范围 | 二级及以上公立医院普通部、本公司认可的医疗机构、指定医院 |
| 续保 | 保证续保、连续投保、自动续保 |
| 既往症 | 投保前已患疾病、已知疾病、既往病史 |

### 0.3 保单元信息（四类共用）

```ts
type PolicyMeta = {
  insurer: Field<string>;
  product_name: Field<string>;
  policy_no: Field<string>;
  category: 'medical' | 'critical_illness' | 'accident' | 'life';
  holder_name: Field<string>;
  insured_name: Field<string>;
  insured_birth: Field<string>;      // 部分保单只给年龄
  insured_age: Field<number>;
  effective_from: Field<string>;
  effective_to: Field<string>;
  premium: Field<number>;
  premium_freq: Field<'single' | 'yearly' | 'monthly' | 'other'>;
  hesitation_days: Field<number>;    // 犹豫期
  waiting_days: Field<number>;       // 等待期（各险种另有细化时以细化字段为准）
  attach_to_main: Field<string>;     // 附加险：所属主险
};
```

## 1. 医疗险（报销型）

最重要、也最容易抽错的一类。责任必须**按项拆开**，不要合成一个「总保额」。

```ts
type MedicalTier = {
  when: string;                      // 触发条件，如「经社保结算」「院外特药」
  when_clause_id: string | null;
  ratio: number | null;              // 0–1
  limit: number | null;              // 该条件下的限额（元）
  cap_scope: 'annual' | 'per_visit' | 'per_day' | 'lifetime' | null;
};

type MedicalItem = {
  code: 'general_inpatient' | 'ci_inpatient' | 'outpatient_surgery'
      | 'special_outpatient' | 'pre_post_outpatient' | 'outpatient_drug'
      | 'off_hospital_drug' | 'proton_heavy_ion' | 'nursing'
      | 'accident_outpatient' | 'dental' | 'maternity' | 'other';
  name: Field<string>;
  benefit_type: 'reimburse';         // 固定，用于跨保单对比
  annual_limit: Field<number>;
  shared_with_main: Field<boolean>;  // 是否与主限额共用
  deductible: Field<number>;
  deductible_scope: Field<'annual' | 'per_visit'>;
  deductible_family_shared: Field<boolean>;
  tiers: MedicalTier[];              // 比例分档（社保内外、特需、特药）
  hospital_scope: Field<string>;     // 公立普通部 / 特需 / 国际部 / 私立
  drug_scope: Field<'social_insurance' | 'any' | 'list_limited'>;
  pre_days: Field<number>;           // 住院前门急诊天数
  post_days: Field<number>;          // 出院后门急诊天数
  max_inpatient_days: Field<number>;
  conditions: Field<string>;         // 给付条件原文归纳
};

type MedicalPolicy = {
  meta: PolicyMeta;
  items: MedicalItem[];
  renewal: {
    guaranteed: Field<boolean>;
    guaranteed_years: Field<number>;
    rate_adjustable: Field<boolean>;
    stop_sale_handling: Field<string>;
  };
  no_claim_discount: Field<string>;   // 无理赔免赔额递减
  social_insurance_required: Field<boolean>;
  pre_existing: Field<'excluded' | 'covered_after_waiting' | 'undefined'>;
  exclusions: ExclusionItem[];
};
```

必须覆盖的免责类型（缺失即视为漏抽）：既往症、等待期内疾病、生育/流产、牙科/视力/整形、康复疗养、职业病、酒驾无证驾驶、高风险运动、战争恐怖袭击、艾滋病、非医疗必需、境外就医。

## 2. 重疾险（给付型）

```ts
type CILevel = {
  ratio: Field<number>;              // 保额比例
  times: Field<number>;              // 赔付次数
  cap_ratio: Field<number>;          // 累计上限（轻症常为 20%–30%）
};

type CriticalIllnessPolicy = {
  meta: PolicyMeta;
  sum_assured: Field<number>;
  disease_count: Field<number>;
  grouping: Field<'none' | 'grouped'>;
  payout_interval_days: Field<number>;   // 多次赔付间隔期
  severe: CILevel;                       // 重疾
  moderate: CILevel;                     // 中症
  mild: CILevel;                         // 轻症
  death_benefit: Field<'sum_assured' | 'premium' | 'none'>;
  total_disability: Field<'sum_assured' | 'none'>;
  disease_terminal: Field<boolean>;
  specific_extra: {                      // 少儿/男性/女性/高龄特定疾病额外赔
    name: string; ratio: number; cap: number | null; clause_id: string;
  }[];
  second_cancer: {
    enabled: boolean;
    interval_days: number | null;
    covers: ('new' | 'recurrence' | 'metastasis' | 'persist')[];
  };
  waiver: Field<'insured' | 'holder' | 'both' | 'none'>;   // 保费豁免
  waiting_days: Field<number>;
  waiting_handling: Field<'refund' | 'no_payout' | 'other'>;
  exclusions: ExclusionItem[];
};
```

**病种定义单独处理**：28 种统一定义之外的自定义病种，把「疾病名 → 定义条款」建成对照，问答时才能回答「这个病算不算重疾」。病种清单过长时按需索引，不要塞进主 schema 的上下文。

## 3. 意外险

```ts
type AccidentPolicy = {
  meta: PolicyMeta;
  death_sum: Field<number>;
  disability_sum: Field<number>;
  share_sum: Field<boolean>;             // 身故与伤残是否共用保额
  disability_table: Field<'gb_2013' | 'other'>;  // 人身保险伤残评定标准 1–10 级
  medical: {
    limit: Field<number>;
    deductible: Field<number>;
    ratio: Field<number>;
    social_only: Field<boolean>;         // 是否限社保内用药
    hospital_scope: Field<string>;
    pre_post_days: Field<number>;
  };
  allowance: {
    per_day: Field<number>;
    deductible_days: Field<number>;
    max_days: Field<number>;
  } | null;
  sudden_death: Field<boolean>;          // 猝死是否额外附加
  transport_extra: {
    kind: 'air' | 'rail' | 'drive' | 'other';
    ratio: number; cap: number | null; clause_id: string;
  }[];
  occupation_scope: Field<string>;       // 1–3 类 / 1–4 类 / 不限
  effective_rule: Field<string>;         // 次日零时 / T+N / 即时生效
  exclusions: ExclusionItem[];
};
```

意外险免责的典型陷阱要单列：疾病所致、中暑/高原反应、妊娠、整容、醉酒、无证驾驶、自杀自伤、打架斗殴、非意外因素。

## 4. 寿险

```ts
type LifePolicy = {
  meta: PolicyMeta;
  death_sum: Field<number>;
  disability_sum: Field<number>;
  share_sum: Field<boolean>;
  term: Field<'to_age' | 'years' | 'lifetime'>;
  term_value: Field<number>;             // 至 X 岁 / X 年
  waiting_days: Field<number>;           // 常见 90 / 180；意外身故通常无等待期
  accidental_no_waiting: Field<boolean>;
  exclusions: ExclusionItem[];
  cash_value: Field<boolean>;
  policy_loan: Field<boolean>;
  reduced_paid_up: Field<boolean>;       // 减额交清
  beneficiary: Field<string>;
};
```

寿险免责通常只有三条（故意杀害被保险人 / 故意犯罪 / 合同成立或复效 2 年内自杀），抽取时应核对**条数是否异常**——出现 10 条以上往往是错把其他险种条款册挂了过来。

## 5. 免责项统一结构

```ts
type ExclusionItem = {
  category: 'pre_existing' | 'waiting_period' | 'intentional' | 'illegal'
          | 'high_risk' | 'maternity' | 'dental_aesthetic' | 'rehab'
          | 'occupational' | 'foreign' | 'other';
  text: string;              // 原文（可截断，但保留语义）
  clause_id: string;
  severity: 'absolute' | 'conditional';  // 绝对除外 / 有条件除外
};
```

## 6. 跨险种对比字段

家庭里四类险种叠在一起时，真正要回答的是「能不能叠加、谁先报」，所以每张保单再补一份事实标签：

```ts
type PolicyFacts = {
  benefit_nature: 'reimburse' | 'payout';  // 报销型 / 给付型
  death_cover: boolean;                    // 是否含身故责任
  medical_expense: boolean;                // 是否报销医疗费用
  stackable: boolean;                      // 是否可与其他保单叠加赔付
  deductible_applies: boolean;
};
```

由它派生的三条分析规则：

1. **给付型可叠加**（重疾、意外伤残、寿险身故），报销型不可重复获利（医疗险、意外医疗）。
2. **身故责任重叠**：寿险 + 意外身故 + 含身故的重疾险，三份可同时赔，需按事故类型分别列出。
3. **免赔额互补**：百万医疗的年免赔额（常见 1 万）之下，可由意外医疗（0 免赔）或住院津贴覆盖——这是家庭配置里最实用的一条提示。

## 7. 抽取时的 clause 选择

不要整本塞进上下文。每类字段只喂相关条款：

| 任务 | 送入的 clause |
|---|---|
| `metadata` | 保险单页、投保单摘要、特别约定 |
| `coverage_list` | `category='保险责任'` 的全部条款（仅标题级） |
| `coverage_detail` | 该责任对应条款 + 命中的释义条款 + 特别约定 |
| `exclusions` | `category='责任免除'` 全量 |
| `renewal/waiver` | 关键词命中（续保、保证续保、豁免）的条款 |

释义条款常被漏送，而「住院」「意外」「既往症」的定义往往决定了结论，属于必带项。

## 8. 每类险种的验收字段（M2/M3 通过条件）

| 险种 | 必须 100% 覆盖的字段 | 准确率目标 |
|---|---|---|
| 医疗险 | 年度限额、免赔额、比例分档、等待期、医院范围、续保条件 | ≥ 90% |
| 重疾险 | 保额、重疾/中症/轻症比例与次数、身故责任、等待期 | ≥ 90% |
| 意外险 | 身故/伤残保额、意外医疗三项（限额·免赔·比例）、职业限制 | ≥ 92%（字段少，要求更高） |
| 寿险 | 身故/全残保额、保险期间、等待期、免责条数 | ≥ 95% |

准确率以人工标注的 gold set 为准（见 `PLAN.md` §11）。任一险种未达标的字段，在界面上必须显示「未识别/待确认」，不得静默留空。
