import geoip from 'geoip-country';

// Cloudflare's country header outranks the IP lookup only when we are deployed behind Cloudflare
// (TRUST_CDN_COUNTRY=1); otherwise anyone can send it, so it's no better than a client hint.
const TRUST_CDN = process.env.TRUST_CDN_COUNTRY === '1';

export const cleanCountry = (s) => (/^[A-Z]{2}$/.test(String(s ?? '')) && !['XX', 'T1', 'ZZ'].includes(s) ? s : null);

/** Loopback, private, link-local and CGNAT ranges (v4, v6 and v4-mapped v6) can't be geolocated. */
export function isPrivateIp(ip) {
  if (typeof ip !== 'string' || !ip || ip === 'unknown') return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b < 128);
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower === '::' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

/** Country of a public IP from the bundled GeoLite2 database, or null. */
export function lookupIp(ip) {
  if (isPrivateIp(ip)) return null;
  try {
    return cleanCountry(geoip.lookup(ip)?.country);
  } catch {
    return null;
  }
}

/** Geolocates a ws upgrade request from the client IP and any CDN country header. */
export function countryOfRequest(req, ip, trustCdn = TRUST_CDN) {
  const cdn = cleanCountry(String(req.headers?.['cf-ipcountry'] ?? '').toUpperCase());
  const geo = lookupIp(ip);
  return trustCdn ? cdn ?? geo : geo ?? cdn;
}

/**
 * The flag we show: IP geolocation beats the browser's time zone, which beats its language region
 * (en-US is the default nearly everywhere). `legacy` is the single `country` older clients send.
 */
export function pickCountry({ geo, tz, lang, legacy } = {}) {
  return cleanCountry(geo) ?? cleanCountry(tz) ?? cleanCountry(lang) ?? cleanCountry(legacy);
}
