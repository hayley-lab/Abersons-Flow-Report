import { returnedRetailValue } from "./flow-math";

function num(value) {
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function displayFlowQty(value) {
  const n = num(value);
  return n === 0 ? "" : n;
}

export function buildProductBuckets(rows) {
  const buckets = {
    ordered: { n: 0, v: 0 },
    stock: { n: 0, v: 0 },
    sold: { n: 0, v: 0 },
    sale: { n: 0, v: 0 },
    returned: { n: 0, v: 0 },
  };

  for (const row of rows || []) {
    const price = num(row?.price);
    const onOrder = num(row?.onOrderQty);
    const onHand = num(row?.onHand);
    const sold = num(row?.sold);
    const onSale = num(row?.onSale);
    const returned = num(row?.retQty);

    if (sold > 0) buckets.sold.n += 1;
    buckets.sold.v += price * sold;

    if (onSale > 0) buckets.sale.n += 1;
    if (onSale !== 0) {
      buckets.sale.v += Object.hasOwn(row || {}, "saleAmt") ? num(row.saleAmt) : price * onSale;
    }

    if (onHand > 0) {
      buckets.stock.n += 1;
      buckets.stock.v += price * onHand;
    }
    if (returned > 0) {
      buckets.returned.n += 1;
      buckets.returned.v += returnedRetailValue(row, price);
    }
    if (onOrder > 0) {
      buckets.ordered.n += 1;
      buckets.ordered.v += price * onOrder;
    }
  }

  return buckets;
}
