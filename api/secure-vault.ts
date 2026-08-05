import { createClient } from '@supabase/supabase-js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const json = (body: unknown, status = 200) => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
function masterKey(): Buffer {
  const raw = process.env.TRADEPILOT_VAULT_KEY;
  if (!raw) throw new Error('TRADEPILOT_VAULT_KEY is not configured.');
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('TRADEPILOT_VAULT_KEY must decode to exactly 32 bytes.');
  return key;
}
function encrypt(value: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
function decrypt(payload: string) {
  const bytes = Buffer.from(payload, 'base64'), iv = bytes.subarray(0, 12), tag = bytes.subarray(12, 28), ciphertext = bytes.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// This endpoint intentionally has no withdrawal/order endpoint. Exchange API
// credentials must be created with withdrawals disabled at the exchange.
export default async function handler(req: any) {
  try {
    if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    if (req.method === 'GET') {
      const { data, error } = await supabase.from('tradepilot_secret_vault').select('id,provider,created_at,updated_at').order('updated_at', { ascending: false }).limit(20);
      if (error) throw error;
      return json({ ok: true, secrets: data ?? [], withdrawals: 'DISABLED' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
    const provider = String(body.provider ?? '').trim();
    const apiKey = String(body.apiKey ?? '');
    const apiSecret = String(body.apiSecret ?? '');
    if (!provider || !apiKey || !apiSecret) return json({ error: 'provider, apiKey and apiSecret are required.' }, 400);
    if (body.allowWithdrawals === true || body.withdrawalsEnabled === true) return json({ error: 'Withdrawal permissions are prohibited by TradePilot policy.' }, 400);
    const encryptedKey = encrypt(apiKey), encryptedSecret = encrypt(apiSecret);
    const { error } = await supabase.from('tradepilot_secret_vault').insert({ provider, encrypted_api_key: encryptedKey, encrypted_api_secret: encryptedSecret });
    if (error) throw error;
    // Decryption is deliberately not exposed through this HTTP API.
    return json({ ok: true, stored: true, encryption: 'AES-256-GCM', withdrawals: 'DISABLED' }, 201);
  } catch (err) {
    console.error('[secure-vault]', err);
    return json({ error: 'Secure vault operation failed.' }, 500);
  }
}

// Keep decrypt available to trusted server-side exchange adapters only.
export { decrypt };
