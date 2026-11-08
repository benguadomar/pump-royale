// Country flag detection: browser time-zone/language hints and the server's choice between them and IP geolocation.
import assert from 'node:assert/strict';
import { countryFromTimeZone, countryFromLanguages } from '../src/data/country.js';
import { pickCountry, isPrivateIp, lookupIp, countryOfRequest } from '../server/geo.js';

const tz = {
  'Africa/Tunis': 'TN', 'Europe/Paris': 'FR', 'Africa/Casablanca': 'MA', 'Africa/Algiers': 'DZ', 'Africa/Cairo': 'EG',
  'America/New_York': 'US', 'America/Los_Angeles': 'US', 'US/Pacific': 'US', 'America/Toronto': 'CA', 'Europe/London': 'GB',
  'Europe/Berlin': 'DE', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Europe/Kyiv': 'UA', 'Europe/Kiev': 'UA',
  'America/Argentina/Buenos_Aires': 'AR', 'America/Sao_Paulo': 'BR', 'Asia/Tokyo': 'JP', 'Australia/Sydney': 'AU', 'Asia/Riyadh': 'SA',
  'Etc/UTC': null, UTC: null, '': null, undefined: null, 'Mars/Olympus': null,
};
for (const [zone, cc] of Object.entries(tz)) assert.equal(countryFromTimeZone(zone === 'undefined' ? undefined : zone), cc, zone);

assert.equal(countryFromLanguages(['fr-TN', 'en-US']), 'TN');
assert.equal(countryFromLanguages(['fr', 'en_gb']), 'GB');
assert.equal(countryFromLanguages(['ar']), null);
assert.equal(countryFromLanguages(undefined), null);

assert.equal(pickCountry({ geo: 'TN', tz: 'FR', lang: 'US', legacy: 'US' }), 'TN');
assert.equal(pickCountry({ geo: null, tz: 'FR', lang: 'US' }), 'FR');
assert.equal(pickCountry({ geo: null, tz: null, lang: 'US' }), 'US');
assert.equal(pickCountry({ legacy: 'DE' }), 'DE');
assert.equal(pickCountry({ geo: 'XX', tz: 'tn', lang: '<b>', legacy: 'MA' }), 'MA');
assert.equal(pickCountry({}), null);
assert.equal(pickCountry(), null);

for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.5', '192.168.1.2', '172.20.0.1', '100.64.1.1', 'fdaa:0:1::2', 'fe80::1', 'unknown', undefined])
  assert.equal(isPrivateIp(ip), true, String(ip));
for (const ip of ['8.8.8.8', '41.226.11.1', '172.32.0.1', '2a01:cb00::1']) assert.equal(isPrivateIp(ip), false, ip);

assert.equal(lookupIp('127.0.0.1'), null);
assert.equal(lookupIp('41.226.11.1'), 'TN');
assert.equal(lookupIp('2a01:cb00::1'), 'FR');
assert.equal(countryOfRequest({ headers: {} }, '127.0.0.1'), null);
assert.equal(countryOfRequest({ headers: { 'cf-ipcountry': 'de' } }, '127.0.0.1'), 'DE');
assert.equal(countryOfRequest({ headers: { 'cf-ipcountry': 'DE' } }, '41.226.11.1', false), 'TN');
assert.equal(countryOfRequest({ headers: { 'cf-ipcountry': 'DE' } }, '41.226.11.1', true), 'DE');
assert.equal(countryOfRequest({ headers: { 'cf-ipcountry': 'XX' } }, '::1', true), null);

console.log('country: ok');
