// Sold Punks mock: builds the last-24h sales list live, client-side.
// Native sales come from the Punks Market indexer. Wrapped-punk sales are
// priced by decoding Seaport OrderFulfilled logs from each transfer's receipt.

const INDEXER = "https://indexer.punksmarket.app";
const RPC = "https://ethereum-rpc.publicnode.com";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
// keccak256("OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])")
const ORDER_FULFILLED = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31";

const WRAPPERS = {
  wrapped_punks: { addr: "0xb7f7f6c52f2e2fdb1963eab30438024864c313f6", version: "V2", label: "WrappedPunks" },
  cryptopunks_721: { addr: "0x000000000000003607fce1ac9e043a86675c5c2f", version: "V2", label: "CryptoPunks721" },
  v1_wrapper: { addr: "0x282bdd42f4eb70e7a9d9f40c8fea0825b7f68c5d", version: "V1", label: "Wrapped" },
};

// Every source belonging to each collection, for history/context lookups.
const GROUP = {
  V1: ["cryptopunks_v1", "v1_wrapper", "punks_market", "punks_auction"],
  V2: ["cryptopunks_v2", "wrapped_punks", "cryptopunks_721", "punks_auction"],
};

async function gql(query) {
  const res = await fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function rpcBatch(calls) {
  if (!calls.length) return [];
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c[0], params: c[1] }))),
  });
  const out = await res.json();
  return out.sort((a, b) => a.id - b.id).map((r) => r.result);
}

const versionOf = (e) => {
  if (e.source === "punks_auction") return e.standard === "cryptopunks_v1" ? "V1" : "V2";
  if (e.source === "cryptopunks_v1" || e.source === "punks_market" || e.source === "v1_wrapper") return "V1";
  return "V2";
};

const VENUE = {
  cryptopunks_v2: "CryptoPunks market",
  cryptopunks_v1: "V1 market",
  punks_market: "Punks Market",
  punks_auction: "punks.auction",
};

// --- Seaport decoding (static tuples, so plain word slicing works) ---
function words(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const w = [];
  for (let i = 0; i < h.length; i += 64) w.push(h.slice(i, i + 64));
  return w;
}
const addr = (word) => "0x" + word.slice(24).toLowerCase();
const big = (word) => BigInt("0x" + word);

function decodeOrderFulfilled(log) {
  const w = words(log.data);
  const offerAt = Number(big(w[2])) / 32;
  const consAt = Number(big(w[3])) / 32;
  const offer = [];
  for (let i = 0, n = Number(big(w[offerAt])); i < n; i++) {
    const b = offerAt + 1 + i * 4;
    offer.push({ type: Number(big(w[b])), token: addr(w[b + 1]), id: big(w[b + 2]), amount: big(w[b + 3]) });
  }
  const consideration = [];
  for (let i = 0, n = Number(big(w[consAt])); i < n; i++) {
    const b = consAt + 1 + i * 5;
    consideration.push({ type: Number(big(w[b])), token: addr(w[b + 1]), id: big(w[b + 2]), amount: big(w[b + 3]), recipient: addr(w[b + 4]) });
  }
  return { offerer: addr(log.topics[1]), offer, consideration };
}

const isCurrency = (it) => it.type === 0 || (it.type === 1 && it.token === WETH);
const isNft = (it) => it.type === 2 || it.type === 4;

// Price for one wrapped token within a tx's Seaport fills, or null if none.
function seaportPrice(receipt, wrapperAddr, tokenId) {
  const fills = receipt.logs.filter((l) => l.topics[0] === ORDER_FULFILLED).map(decodeOrderFulfilled);
  const match = (it) => isNft(it) && it.token === wrapperAddr && it.id === BigInt(tokenId);
  for (const f of fills) {
    let side = null;
    if (f.offer.some(match)) side = "listing";
    else if (f.consideration.some(match)) side = "offer";
    if (!side) continue;
    const money = side === "listing" ? f.consideration.filter(isCurrency) : f.offer.filter(isCurrency);
    if (!money.length) continue;
    const nfts = (side === "listing" ? f.offer : f.consideration).filter(isNft);
    const wei = money.reduce((s, it) => s + it.amount, 0n);
    const currency = money.some((it) => it.type === 1) ? "WETH" : "ETH";
    return { wei, currency, via: side === "listing" ? "listing" : "accepted offer", bundle: nfts.length > 1 ? nfts.length : 0 };
  }
  return null;
}

// --- Main ---
export async function loadSales({ hours = 24, now = Date.now() / 1000 } = {}) {
  const since = Math.floor(now - hours * 3600);

  const data = await gql(`{
    sales: events(where:{type:"sale", timestamp_gte:"${since}"}, orderBy:"timestamp", orderDirection:"desc", limit:1000) {
      items { id source source_event standard punk_id buyer seller wei_amount usd_value_cents tx_hash log_index timestamp }
    }
    wraps: events(where:{type:"transfer", source_in:["wrapped_punks","cryptopunks_721","v1_wrapper"], timestamp_gte:"${since}"}, orderBy:"timestamp", orderDirection:"desc", limit:1000) {
      items { source punk_id from to tx_hash log_index timestamp }
    }
  }`);

  // Native sales: drop private 0 ETH sales, map collections.
  let sales = data.sales.items
    .filter((e) => BigInt(e.wei_amount || 0) > 0n)
    .map((e) => ({
      key: "",
      version: versionOf(e),
      wrapper: null,
      source: e.source,
      venue: VENUE[e.source] || e.source,
      via: e.source_event === "BidAccepted" ? "accepted bid" : e.source === "punks_auction" ? "auction" : "",
      punk: Number(e.punk_id),
      buyer: e.buyer,
      seller: e.seller,
      wei: BigInt(e.wei_amount),
      usdCents: e.usd_value_cents ? Number(e.usd_value_cents) : null,
      currency: "ETH",
      tx: e.tx_hash,
      ts: Number(e.timestamp),
      needsV1Fix: e.source === "cryptopunks_v1" && e.buyer === e.seller,
      bundle: 0,
    }));

  // Wrapped sales: decode Seaport fills in each wrapper transfer's receipt.
  const wraps = data.wraps.items;
  const txs = [...new Set(wraps.map((w) => w.tx_hash))];
  const receipts = await rpcBatch(txs.map((h) => ["eth_getTransactionReceipt", [h]]));
  const byTx = Object.fromEntries(txs.map((h, i) => [h, receipts[i]]));
  for (const w of wraps) {
    const r = byTx[w.tx_hash];
    if (!r) continue;
    const meta = WRAPPERS[w.source];
    const p = seaportPrice(r, meta.addr, w.punk_id);
    if (!p) continue; // no marketplace fill: plain transfer
    sales.push({
      version: meta.version,
      wrapper: meta.label,
      source: w.source,
      venue: "OpenSea (Seaport)",
      via: p.via,
      punk: Number(w.punk_id),
      buyer: w.to,
      seller: w.from,
      wei: p.wei,
      usdCents: null,
      currency: p.currency,
      tx: w.tx_hash,
      ts: Number(w.timestamp),
      bundle: p.bundle,
    });
  }

  // Dedupe on (collection, punk, tx). Punks Market and punks.auction rows win
  // over the raw V1 PunkBought their intermediary emits in the same tx.
  const rank = { punks_market: 0, punks_auction: 0, cryptopunks_v1: 1 };
  sales.sort((a, b) => (rank[a.source] ?? 0) - (rank[b.source] ?? 0));
  const seen = new Set();
  sales = sales.filter((s) => {
    const k = `${s.wrapper || s.version}:${s.punk}:${s.tx}`;
    const kNative = `${s.version}:${s.punk}:${s.tx}`;
    if (seen.has(k) || seen.has(kNative)) return false;
    seen.add(k);
    seen.add(kNative);
    return true;
  });
  sales.sort((a, b) => b.ts - a.ts);

  await addHistory(sales);
  await addNames(sales);
  return sales;
}

// Per-sale history: fixes intermediary V1 sales and builds the context line.
async function addHistory(sales) {
  if (!sales.length) return;
  const parts = sales.map((s, i) => `
    h${i}: events(where:{punk_id:"${s.punk}", source_in:${JSON.stringify(GROUP[s.version])}, timestamp_lte:"${s.ts}"}, orderBy:"timestamp", orderDirection:"desc", limit:60) {
      items { source type source_event standard from to seller buyer wei_amount tx_hash timestamp }
    }`);
  const data = {};
  for (let i = 0; i < parts.length; i += 6) Object.assign(data, await gql(`{${parts.slice(i, i + 6).join("")}}`));

  sales.forEach((s, i) => {
    const evs = data[`h${i}`].items.filter((e) => e.source !== "punks_auction" || versionOf(e) === s.version);

    if (s.needsV1Fix) {
      const hop = evs.find((e) => e.tx_hash === s.tx && e.source_event === "PunkTransfer" && e.from === s.buyer);
      const listed = evs.find((e) => e.source_event === "PunkOffered" && e.tx_hash !== s.tx);
      if (hop) s.buyer = hop.to;
      if (listed) s.seller = listed.from;
      s.venue = "V1 market (intermediary)";
    }

    // Previous paid sale of this punk on the same collection, before this tx.
    const prev = evs.find((e) => e.type === "sale" && e.tx_hash !== s.tx && BigInt(e.wei_amount || 0) > 0n);
    const notes = [];
    if (prev) {
      const gap = s.ts - Number(prev.timestamp);
      notes.push(`previous on-contract sale ${span(gap)} ago, ${eth(BigInt(prev.wei_amount))} ETH`);
    }
    // When and how the seller got it: the most recent event that moved it to them.
    const got = evs.find((e) => e.tx_hash !== s.tx && (e.to === s.seller || e.buyer === s.seller) && ["sale", "transfer", "assign", "wrap", "unwrap"].includes(e.type));
    s._notes = notes;
    if (got) {
      s._held = s.ts - Number(got.timestamp);
      s._how = got.type === "sale" ? "bought" : got.type === "assign" ? "claimed" : "transfer";
      s._from = got.type === "transfer" ? got.from : null;
      // Who put it into that contract, to tell a loan payoff from a foreclosure.
      if (s._from) {
        const dep = evs.find((e) => Number(e.timestamp) <= Number(got.timestamp) && e.tx_hash !== got.tx_hash && e.to === s._from);
        s._depositor = dep ? dep.from : null;
      }
    }
  });

  // Name any contract the seller received the punk from (lending, vaults...).
  const froms = [...new Set(sales.map((s) => s._from).filter(Boolean))];
  const res = await rpcBatch(froms.map((a) => ["eth_call", [{ to: a, data: "0x06fdde03" }, "latest"]]));
  const cname = {};
  froms.forEach((a, i) => { const n = decodeString(res[i]); if (n) cname[a] = n; });

  for (const s of sales) {
    const notes = s._notes || [];
    if (s._held != null) {
      const t = span(s._held);
      const n = s._from && cname[s._from];
      if (n && /loan/i.test(n)) {
        const proto = /gondi/i.test(n) ? "Gondi" : prettyName(n);
        notes.push(s._depositor && s._depositor !== s.seller
          ? `seller got it ${t} earlier by foreclosing a ${proto} loan`
          : `seller took it back out of a ${proto} loan ${t} earlier`);
      } else if (n) {
        notes.push(`seller got it ${t} earlier from ${prettyName(n)} (not a sale)`);
      } else if (s._how === "bought") {
        notes.push(`seller bought it ${t} earlier`);
      } else if (s._how === "claimed") {
        notes.push(`seller claimed it ${t} earlier`);
      } else {
        notes.push(`seller held it ${t}`);
      }
    }
    s.note = notes.map((n) => n[0].toUpperCase() + n.slice(1)).join(". ");
    delete s._notes; delete s._held; delete s._how; delete s._from; delete s._depositor;
  }
}

function decodeString(hex) {
  try {
    if (!hex || hex.length < 130) return null;
    const h = hex.slice(2);
    const n = parseInt(h.slice(64, 128), 16);
    if (!n || n > 100) return null;
    const bytes = h.slice(128, 128 + n * 2).match(/../g).map((b) => parseInt(b, 16));
    return new TextDecoder().decode(new Uint8Array(bytes)).replace(/[^\x20-\x7e]/g, "").trim() || null;
  } catch { return null; }
}
const prettyName = (n) => n.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// ENS names from the indexer's profile cache. Only the `ens` field is used.
async function addNames(sales) {
  const addrs = [...new Set(sales.flatMap((s) => [s.buyer, s.seller]).filter(Boolean))];
  const names = {};
  await Promise.all(
    addrs.map(async (a) => {
      try {
        const r = await fetch(`${INDEXER}/profiles/${a}`);
        if (r.ok) {
          const j = await r.json();
          if (j.ens) names[a] = j.ens;
        }
      } catch {}
    })
  );
  for (const s of sales) {
    s.buyerName = names[s.buyer] || null;
    s.sellerName = names[s.seller] || null;
  }
}

export function eth(wei) {
  const n = Number(wei) / 1e18;
  return n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
}

export function span(sec) {
  const d = sec / 86400;
  if (d >= 365) return `${(d / 365).toFixed(d >= 3650 ? 0 : 1)} years`;
  if (d >= 60) return `${Math.round(d / 30)} months`;
  if (d >= 2) return `${Math.round(d)} days`;
  const h = sec / 3600;
  if (h >= 2) return `${Math.round(h)} hours`;
  return `${Math.max(1, Math.round(sec / 60))} min`;
}
