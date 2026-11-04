const COUNTRY_CODE = /^[A-Z]{2}$/;

export function registrationCountryForRequest(request: Request): string | null {
  const header = process.env.VERCEL === '1'
    ? 'x-vercel-ip-country'
    : process.env.REGISTRATION_COUNTRY_TRUSTED_HEADER?.trim();

  if (!header) return null;

  const country = request.headers.get(header)?.trim().toUpperCase();
  if (!country || !COUNTRY_CODE.test(country) || country === 'XX' || country === 'ZZ') return null;
  return country;
}
