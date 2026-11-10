/** 估算页交给 AI 分析接口的请求体（都是页面上填的原始数值，不含身份信息）。 */

export type ClaimRequest = {
  benefit: string;
  scope: string;
  cost: number;
  social: number;
  other: number;
  usedSocial: boolean;
  /** null = 未提供医保目录内金额 */
  catalog: number | null;
  waiting: boolean;
  /** 免责情形在列表中的下标；null = 未命中 */
  exclusionIndex: number | null;
  paid: number;
  /** 分项限额：本次费用中属于该类的金额 */
  subLimits?: { label: string; limit: number; amount: number }[];
  /** 给付比例表型责任：用户按附表查到的比例（%），null = 未填 */
  flatRatio?: number | null;
};
