'use client';

import { Globe2 } from 'lucide-react';
import { useI18n } from './studio-i18n';

type RegistrationCountry = { country: string; count: number };

const countryDisplayNames = new Intl.DisplayNames(['en'], { type: 'region' });

function countryName(country: string, unknownLabel: string) {
  if (country === 'ZZ') return unknownLabel;
  return countryDisplayNames.of(country) ?? country;
}

export function DashboardCountryBreakdown({ registrationCountries }: { registrationCountries: RegistrationCountry[] }) {
  const { t } = useI18n();
  const trackedCountryProfiles = registrationCountries.reduce((sum, item) => sum + item.count, 0);
  const largestCountryCount = Math.max(...registrationCountries.map(item => item.count), 0);

  return (
    <section className="dashboard-panel dashboard-country-panel">
      <div className="dashboard-panel-heading">
        <div className="dashboard-country-heading">
          <span className="dashboard-icon">
            <Globe2 size={20} />
          </span>
          <div>
            <h2>{t('studio.dashboard.registrationCountries')}</h2>
            <p>{t('studio.dashboard.registrationCountriesHelp')}</p>
          </div>
        </div>
        <div className="dashboard-country-total">
          <strong>{trackedCountryProfiles.toLocaleString()}</strong>
          <span>{t('studio.dashboard.countryProfilesTracked')}</span>
        </div>
      </div>
      {registrationCountries.length ? (
        <ol className="dashboard-country-list">
          {registrationCountries.map(item => (
            <li key={item.country}>
              <div className="dashboard-country-row">
                <span>{countryName(item.country, t('studio.dashboard.countryUnknown'))}</span>
                <strong>{item.count.toLocaleString()}</strong>
              </div>
              <div className="dashboard-country-track" aria-hidden="true">
                <span style={{ width: `${Math.max(2, item.count / largestCountryCount * 100)}%` }} />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="dashboard-empty-label">{t('studio.dashboard.registrationCountriesEmpty')}</p>
      )}
    </section>
  );
}
