import Decimal from 'decimal.js';
import { BadRequestException } from '@nestjs/common';
export type Movement = 'transfer' | 'borrow' | 'lend' | 'collect' | 'repay';
export function movementDeltas(
  operation: Movement,
  amount: string,
  received: string,
  fee: string,
  sourceSide = 'asset',
  targetSide = 'asset',
) {
  const incoming = operation === 'borrow' || operation === 'collect';
  const principal = new Decimal(amount),
    charge = new Decimal(fee),
    debt = new Decimal(received);
  if (operation === 'transfer')
    return {
      source: principal.plus(charge).mul(sourceSide === 'liability' ? 1 : -1),
      target: debt.mul(targetSide === 'liability' ? -1 : 1),
      sourceReason: 'transfer_out',
      targetReason: 'transfer_in',
    };
  if (incoming && charge.gt(principal)) throw new BadRequestException('收款手续费不能超过收款金额');
  return {
    source: incoming ? principal.minus(charge) : principal.plus(charge).neg(),
    target: operation === 'borrow' || operation === 'lend' ? debt : debt.neg(),
    sourceReason: 'loan_' + operation,
    targetReason: 'loan_' + operation,
  };
}
