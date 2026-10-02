import { useSyncExternalStore, useEffect } from 'react';
import english from './locales/en.json';
import traditional from './locales/zh-Hant.json';
export type Locale = 'zh-Hans' | 'en' | 'zh-Hant';
const storageKey = 'worthpath.locale';
export const localeOptions: { value: Locale; label: string }[] = [
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'zh-Hant', label: '繁體中文' },
];
export const validLocale = (value: unknown): value is Locale =>
  localeOptions.some((option) => option.value === value);
function initialLocale(): Locale {
  try {
    const value = localStorage.getItem(storageKey);
    return validLocale(value) ? value : 'zh-Hans';
  } catch {
    return 'zh-Hans';
  }
}
let locale = initialLocale();
const listeners = new Set<() => void>();
const originalPhrases = new Map<string, string>();
for (const dictionary of [english, traditional])
  for (const [key, value] of Object.entries(dictionary))
    if (!originalPhrases.has(value)) originalPhrases.set(value, key);
const compoundPhrases = Object.keys(english)
  .filter((key) => key.length >= 6)
  .sort((a, b) => b.length - a.length);
export function setLocale(value: Locale) {
  if (!validLocale(value)) return;
  locale = value;
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    /* Session-only preference if storage is unavailable. */
  }
  listeners.forEach((listener) => listener());
}
export function translate(text: string, language: Locale): string {
  const original = originalPhrases.get(text) || text;
  if (language === 'zh-Hans') return original;
  const dictionary: Record<string, string> = language === 'en' ? english : traditional;
  if (dictionary[original] !== undefined) return dictionary[original];
  // Server validation messages can include a field prefix or a date. Translate
  // only known application phrases; user names and notes never pass through t().
  let result = original;
  for (const key of compoundPhrases) {
    if (result.includes(key)) result = result.split(key).join(dictionary[key]);
  }
  return result;
}
export const t = (text: string) => translate(text, locale);
export function useLocale() {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => locale,
    () => 'zh-Hans' as Locale,
  );
  useEffect(() => {
    document.documentElement.lang = value;
    document.title = 'WorthPath · ' + translate('我的资产空间', value);
  }, [value]);
  return value;
}
export function LanguagePicker() {
  const value = useLocale();
  return (
    <label className="language-picker">
      <span>{t('语言')}</span>
      <select
        aria-label={t('语言')}
        value={value}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {localeOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
