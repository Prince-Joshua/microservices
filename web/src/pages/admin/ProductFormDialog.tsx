import { useState, type FormEvent } from "react";
import { Button, Dialog, Field, Input, Portal, Stack, Switch } from "@chakra-ui/react";
import { productsApi } from "../../api/products";
import type { Product } from "../../api/types";
import { errorMessage } from "../../api/http";
import { isWholeCents } from "../../lib/format";
import { ProductImage } from "../../components/ProductImage";

/** Empty is fine (no image); otherwise it must be an http(s) link. */
function isImageLink(value: string): boolean {
  if (!value) return true;
  if (value.length > 2000) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Create (product omitted) or edit. Mount it only while open so its fields start fresh. */
export function ProductFormDialog({
  product,
  onClose,
  onSaved,
}: {
  product?: Product;
  onClose: () => void;
  onSaved: (saved: Product) => void;
}) {
  const editing = Boolean(product);
  const [name, setName] = useState(product?.name ?? "");
  const [price, setPrice] = useState(product ? String(product.price) : "");
  const [stock, setStock] = useState("0");
  const [imageUrl, setImageUrl] = useState(product?.imageUrl ?? "");
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const priceNum = Number(price);
    const stockNum = Number(stock);

    if (!name.trim() || name.trim().length > 200) return setError("Name must be 1–200 characters");
    if (price === "" || !Number.isFinite(priceNum) || priceNum < 0 || !isWholeCents(priceNum)) {
      return setError("Price must be 0 or more, with at most two decimals");
    }
    if (!isImageLink(imageUrl.trim())) return setError("Image link must start with http:// or https://");
    if (!editing && (!Number.isSafeInteger(stockNum) || stockNum < 0)) {
      return setError("Stock must be a whole number, 0 or more");
    }

    setBusy(true);
    setError(null);
    try {
      const saved = product
        ? await productsApi.update(product.id, { name: name.trim(), price: priceNum, imageUrl: imageUrl.trim(), isActive })
        : await productsApi.create({ name: name.trim(), price: priceNum, stockQuantity: stockNum, imageUrl: imageUrl.trim() });
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open placement="center" onOpenChange={(e) => !e.open && !busy && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={submit}>
            <Dialog.Header>
              <Dialog.Title>{editing ? "Edit product" : "New product"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <Field.Root required invalid={Boolean(error)}>
                  <Field.Label>Name</Field.Label>
                  <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
                </Field.Root>
                <Field.Root required>
                  <Field.Label>Price</Field.Label>
                  <Input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Image link (optional)</Field.Label>
                  <Input
                    type="url"
                    inputMode="url"
                    placeholder="https://example.com/photo.jpg"
                    value={imageUrl}
                    maxLength={2000}
                    onChange={(e) => setImageUrl(e.target.value)}
                  />
                  <Field.HelperText>Paste a direct link to an image.</Field.HelperText>
                </Field.Root>
                {imageUrl.trim() && isImageLink(imageUrl.trim()) && (
                  <ProductImage src={imageUrl.trim()} alt="Preview" ratio={16 / 9} />
                )}
                {!editing ? (
                  <Field.Root>
                    <Field.Label>Initial stock</Field.Label>
                    <Input type="number" min={0} step={1} value={stock} onChange={(e) => setStock(e.target.value)} />
                  </Field.Root>
                ) : (
                  <Switch.Root checked={isActive} onCheckedChange={(e) => setIsActive(e.checked)} colorPalette="brand">
                    <Switch.HiddenInput />
                    <Switch.Control />
                    <Switch.Label>Active (visible to customers)</Switch.Label>
                  </Switch.Root>
                )}
                {error && (
                  <Field.Root invalid>
                    <Field.ErrorText>{error}</Field.ErrorText>
                  </Field.Root>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" colorPalette="brand" loading={busy}>
                {editing ? "Save changes" : "Create product"}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** POST /products/:id/stock { delta }. Not idempotent, so there is no auto-retry. */
export function StockDialog({
  product,
  onClose,
  onSaved,
}: {
  product: Product;
  onClose: () => void;
  onSaved: (saved: Product) => void;
}) {
  const [delta, setDelta] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(delta);
    if (!Number.isSafeInteger(n) || n === 0) return setError("Enter a non-zero whole number (negative removes stock)");
    if (n < 0 && -n > product.stockQuantity) return setError(`Only ${product.stockQuantity} in stock`);

    setBusy(true);
    setError(null);
    try {
      onSaved(await productsApi.adjustStock(product.id, n));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open placement="center" onOpenChange={(e) => !e.open && !busy && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={submit}>
            <Dialog.Header>
              <Dialog.Title>Adjust stock · {product.name}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Field.Root invalid={Boolean(error)}>
                <Field.Label>Change by</Field.Label>
                <Input type="number" step={1} placeholder="e.g. 10 or -3" value={delta} onChange={(e) => setDelta(e.target.value)} autoFocus />
                <Field.HelperText>Currently {product.stockQuantity} in stock</Field.HelperText>
                <Field.ErrorText>{error}</Field.ErrorText>
              </Field.Root>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" colorPalette="brand" loading={busy}>
                Apply
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
