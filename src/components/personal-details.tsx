'use client';
import { useI18n } from './studio-i18n';
import type { PersonalDetails } from '../lib/studio-policy.mjs';
export const emptyDetails: PersonalDetails = { firstName: '', lastName: '', displayName: '', country: '', bio: '' };
export function PersonalDetailsFields({ value, onChange, disabled }: { value: PersonalDetails; onChange: (value: PersonalDetails) => void; disabled?: boolean }) {
  const { t } = useI18n();
  return <><div className="form-grid">{(['firstName', 'lastName', 'displayName', 'country'] as const).map(key => <label key={key}>{t(`studio.fields.${key}`)}<input value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })} maxLength={80} autoComplete={key === 'firstName' ? 'given-name' : key === 'lastName' ? 'family-name' : key === 'country' ? 'country-name' : 'nickname'} required disabled={disabled}/></label>)}</div><label>{t('studio.fields.bio')}<textarea value={value.bio} onChange={event => onChange({ ...value, bio: event.target.value })} maxLength={1000} rows={3} disabled={disabled}/></label></>;
}
