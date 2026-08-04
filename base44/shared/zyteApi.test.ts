import {
  assertAllowedZyteUrl,
  decodeZyteHttpBody,
  extractAmazonAsin,
} from "./zyteApi.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Esperado ${String(expected)}, recebido ${String(actual)}`);
  }
}

function assertThrows(callback: () => unknown) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error("Era esperada uma exceção.");
}

Deno.test("Zyte permite somente páginas públicas Amazon em HTTPS", () => {
  assertEquals(
    assertAllowedZyteUrl("https://www.amazon.com.br/s?k=lixeira").hostname,
    "www.amazon.com.br",
  );
  assertThrows(() =>
    assertAllowedZyteUrl("http://www.amazon.com.br/s?k=lixeira")
  );
  assertThrows(() => assertAllowedZyteUrl("https://example.com/amazon"));
});

Deno.test("extrai ASIN de URLs Amazon suportadas", () => {
  assertEquals(
    extractAmazonAsin("https://www.amazon.com.br/dp/B0GFQ5YT3H/ref=x"),
    "B0GFQ5YT3H",
  );
  assertEquals(
    extractAmazonAsin("https://www.amazon.com/gp/product/B0GFQ7SY5W"),
    "B0GFQ7SY5W",
  );
  assertEquals(
    extractAmazonAsin("https://www.amazon.com.br/s?k=lixeira"),
    null,
  );
});

Deno.test("decodifica o corpo base64 retornado pela Zyte", () => {
  const original = '["lixeira",["lixeira automática"]]';
  const bytes = new TextEncoder().encode(original);
  const encoded = btoa(String.fromCharCode(...bytes));
  assertEquals(decodeZyteHttpBody(encoded), original);
});
