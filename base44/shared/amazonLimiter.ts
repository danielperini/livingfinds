type Bucket = { nextAt: number };

const buckets = new Map<string, Bucket>();

export async function waitForAmazonSlot(key: string, ratePerSecond = 1) {
  const rate = Math.max(0.1, Number(ratePerSecond) || 1);
  const interval = Math.ceil(1000 / rate);
  const current = buckets.get(key) || { nextAt: 0 };
  const delay = Math.max(0, current.nextAt - Date.now());
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  current.nextAt = Date.now() + interval;
  buckets.set(key, current);
}
