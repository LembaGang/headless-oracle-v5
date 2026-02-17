const crypto = require('crypto');
const fs = require('fs');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

fs.writeFileSync('oracle_private_key_v1.pem', privateKey);
fs.writeFileSync('oracle_public_key_v1.pem', publicKey);
console.log('✅ Keys generated successfully.');