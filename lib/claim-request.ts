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
};
