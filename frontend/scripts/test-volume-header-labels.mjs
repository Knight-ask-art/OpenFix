import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const component = readFileSync(new URL('src/features/writing/components/volume-header.tsx', root), 'utf8');
const keys = [...component.matchAll(/t\("(common\.[^"]+)"\)/g)].map(match => match[1]);
assert.ok(keys.includes('common.collapse'));
assert.ok(keys.includes('common.expand'));
for (const locale of ['zh-CN', 'en']) {
  const messages = JSON.parse(readFileSync(new URL(`src/i18n/locales/${locale}.json`, root), 'utf8'));
  for (const key of keys) {
    const value = key.split('.').reduce((current, part) => current?.[part], messages);
    assert.equal(typeof value, 'string', `${locale}: missing ${key}`);
    assert.ok(value.trim().length > 0, `${locale}: empty ${key}`);
    assert.notEqual(value, key, `${locale}: untranslated ${key}`);
  }
}
console.log('Volume header labels: both locales resolve all common keys');
