import 'dotenv/config';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const c = new SuiGraphQLClient({ url: 'https://graphql.testnet.sui.io/graphql' });

const r = await c.query({
  query: `query {
    events(
      filter: { type: "0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546::bonding_curve::TokensPurchased" }
      first: 50
    ) {
      nodes {
        contents { json }
        transaction { digest }
      }
    }
  }`
});

const evts = r.data?.events?.nodes ?? [];
const nxt7 = evts.filter(e => JSON.stringify(e).includes('358f9b4c'));
console.log('Total V8 TokensPurchased events on GraphQL:', evts.length);
console.log('NXT7 events:', nxt7.length);
if (nxt7.length > 0) console.log(JSON.stringify(nxt7, null, 2));
else {
  console.log('NXT7 not found in first 50. Sample curve_ids:');
  evts.slice(0,5).forEach(e => console.log(' ', e.contents?.json?.curve_id, e.transaction?.digest?.slice(0,20)));
}
