// UI: positive discount, negative surcharge. API stores the opposite fee sign.
// Flip the decimal string directly to preserve all eight fractional digits.
export function repaymentFee(discount: string) {
  if (!/^-?(0|[1-9]\d{0,15})(\.\d{1,8})?$/.test(discount)) throw new Error('还款优惠格式无效');
  if (/^-?0(?:\.0+)?$/.test(discount)) return '0';
  return discount.startsWith('-') ? discount.slice(1) : '-' + discount;
}
