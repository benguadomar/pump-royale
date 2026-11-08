import { log } from './log.js';

/**
 * Optional public HTTPS address through ngrok, for hosts that only give a raw IP:port (e.g. Altare).
 * Enabled by NGROK_AUTHTOKEN; NGROK_DOMAIN pins the account's static domain so the address never
 * changes. The SDK reconnects the tunnel by itself if the network drops.
 */
export async function startTunnel(port) {
  const authtoken = process.env.NGROK_AUTHTOKEN;
  if (!authtoken) return null;
  try {
    const ngrok = await import('@ngrok/ngrok');
    const listener = await ngrok.forward({ addr: port, authtoken, domain: process.env.NGROK_DOMAIN || undefined });
    log.info('ngrok tunnel online', { url: listener.url() });
    return listener;
  } catch (e) {
    log.error('ngrok tunnel failed', { err: e.message });
    return null;
  }
}
