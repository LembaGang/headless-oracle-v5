# Receipt Signing Rules
Every signed receipt MUST follow this exact structure.
Required Fields: mic, status, timestamp, expires_at, issuer ("headlessoracle.com"), key_id, receipt_mode ("demo" or "live"), signature (hex-encoded Ed25519).
Canonical Payload: All fields except signature, keys sorted alphabetically, JSON.stringify with no whitespace, sign with Ed25519.
Safety: NEVER return unsigned receipt. NEVER let caller set receipt_mode. NEVER cache beyond expires_at. Any new field MUST be in canonical payload.
