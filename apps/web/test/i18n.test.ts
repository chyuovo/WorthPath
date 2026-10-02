import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate, validLocale } from '../src/i18n';
import english from '../src/locales/en.json';
import traditional from '../src/locales/zh-Hant.json';
test('locale dictionaries match and preserve monetary values and the required confirmation phrase', () => {
  assert.deepEqual(Object.keys(english), Object.keys(traditional));
  assert.equal(translate('账户', 'en'), 'Accounts');
  assert.equal(translate('账户', 'zh-Hant'), '賬戶');
  assert.equal(translate('Accounts', 'zh-Hans'), '账户');
  assert.equal(translate('借入到账', 'en'), 'Receive a loan');
  for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
    assert.equal(translate('确定清空', locale), '确定清空');
    assert.equal(translate('9999999999999999.98765432', locale), '9999999999999999.98765432');
  }
  assert.equal(
    translate('fee: 手续费优惠不能超过转出金额', 'en'),
    'fee: The discount cannot exceed the payment amount.',
  );
  assert.equal(validLocale('en'), true);
  assert.equal(validLocale('fr'), false);
});
