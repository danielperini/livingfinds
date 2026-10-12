import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../components/ui/toast.jsx", import.meta.url), "utf8");

test("toast overlay wrappers do not intercept page interactions", () => {
  const provider = source.match(/const ToastProvider[\s\S]*?ToastProvider\.displayName/);
  const viewport = source.match(/const ToastViewport[\s\S]*?ToastViewport\.displayName/);
  assert.ok(provider, "ToastProvider source exists");
  assert.ok(viewport, "ToastViewport source exists");
  assert.match(provider[0], /pointer-events-none/);
  assert.match(viewport[0], /pointer-events-none/);
  assert.match(source, /group pointer-events-auto/, "visible toasts remain interactive");
});
