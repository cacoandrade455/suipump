import { client } from './config.js';

const poolId = '0x361056184d24acf4af71240b5e0f44678de9a08d765bff55026be6954cc100de';

const obj = await client.getObject({ id: poolId, options: { showOwner: true, showType: true, showContent: true } });
console.log('type:', obj.data?.type);
console.log('owner:', JSON.stringify(obj.data?.owner, null, 2));
console.log('error:', obj.error);
