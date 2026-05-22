import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const tools = [
  'xyz.suipump.buy@1',
  'xyz.suipump.sell@1',
  'xyz.suipump.launch@1',
  'xyz.suipump.claim@1',
  'xyz.suipump.alerts@1',
];

console.log('Tool signing keys (save these securely):');
console.log('');

const toolsConfig = {};
for (const tool of tools) {
  const kp = new Ed25519Keypair();
  const sk = Buffer.from(kp.getSecretKey()).toString('hex').slice(0, 64);
  toolsConfig[tool] = { tool_kid: 0, tool_signing_key: sk };
  console.log(`${tool}: ${sk}`);
}

console.log('');
console.log('Paste this into your toolkit config JSON under "tools":');
console.log(JSON.stringify(toolsConfig, null, 2));
