// src/v5_crypto.ts

export async function signReceipt(mic: string, status: string, source: string, env: any): Promise<any> {
  const timestamp = new Date().toISOString();
  const payload = {
    receipt_id: crypto.randomUUID(),
    issued_at: timestamp,
    mic: mic.toUpperCase(),
    status,
    source,
    terms_hash: "v5.0-beta",
    public_key_id: env.PUBLIC_KEY_ID || "primary-key-1"
  };

  try {
    const secretStr = env.ED25519_PRIVATE_KEY?.trim();
    if (!secretStr) throw new Error("Missing Private Key Secret");

    // Direct conversion from Base64 to Binary
    const binary = Uint8Array.from(atob(secretStr), c => c.charCodeAt(0));

    // Import as pkcs8 - The "Proper" way to sign
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      binary,
      { name: 'Ed25519' },
      false,
      ['sign']
    );

    const dataToSign = new TextEncoder().encode(JSON.stringify(payload));
    const sigBuffer = await crypto.subtle.sign('Ed25519', privateKey, dataToSign);

    const signature = Array.from(new Uint8Array(sigBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return { ...payload, signature };

  } catch (err: any) {
    return {
      error: "SIGNING_ERROR",
      message: err.message,
      status,
      mic
    };
  }
}