import { useState, type FormEvent } from "react";
import { Badge, Button, HStack, Input, Skeleton, Stack, Switch, Table, Text } from "@chakra-ui/react";
import { productsApi } from "../../api/products";
import type { Product } from "../../api/types";
import { useFetch } from "../../hooks/useFetch";
import { PageHeader } from "../../components/PageHeader";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Pagination } from "../../components/Pagination";
import { ProductImage } from "../../components/ProductImage";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { formatMoney } from "../../lib/format";
import { notifyError, notifySuccess } from "../../components/ui/toaster";
import { ProductFormDialog, StockDialog } from "./ProductFormDialog";

const LIMIT = 15;

export function AdminProductsPage() {
  const [page, setPage] = useState(1);
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(true);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [stocking, setStocking] = useState<Product | null>(null);
  const [deactivating, setDeactivating] = useState<Product | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, error, loading, reload } = useFetch(
    (signal) => productsApi.list({ q, page, limit: LIMIT, includeInactive }, signal),
    [q, page, includeInactive]
  );

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setQ(input.trim());
  };

  const saved = (message: string) => () => {
    setCreating(false);
    setEditing(null);
    setStocking(null);
    notifySuccess(message);
    reload();
  };

  const deactivate = async () => {
    if (!deactivating) return;
    setBusyId(deactivating.id);
    try {
      await productsApi.deactivate(deactivating.id);
      notifySuccess("Product deactivated");
      setDeactivating(null);
      reload();
    } catch (err) {
      notifyError("Couldn't deactivate", err);
    } finally {
      setBusyId(null);
    }
  };

  const reactivate = async (p: Product) => {
    setBusyId(p.id);
    try {
      await productsApi.update(p.id, { isActive: true });
      notifySuccess("Product reactivated");
      reload();
    } catch (err) {
      notifyError("Couldn't reactivate", err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Manage products"
        subtitle="Create, edit and restock your catalogue"
        actions={
          <Button colorPalette="brand" onClick={() => setCreating(true)}>
            New product
          </Button>
        }
      />

      <HStack mb="4" gap="4" wrap="wrap" justify="space-between">
        <form onSubmit={onSearch}>
          <HStack>
            <Input placeholder="Search by name" value={input} onChange={(e) => setInput(e.target.value)} w="64" />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </HStack>
        </form>
        <Switch.Root
          checked={includeInactive}
          onCheckedChange={(e) => {
            setPage(1);
            setIncludeInactive(e.checked);
          }}
          colorPalette="brand"
        >
          <Switch.HiddenInput />
          <Switch.Control />
          <Switch.Label>Show inactive</Switch.Label>
        </Switch.Root>
      </HStack>

      <ErrorAlert error={error} onRetry={reload} title="Couldn't load products" />

      {loading && !data ? (
        <Stack gap="2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height="10" />
          ))}
        </Stack>
      ) : (
        <Table.ScrollArea borderWidth="1px" rounded="md" bg="bg" opacity={loading ? 0.6 : 1}>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Name</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Price</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Stock</Table.ColumnHeader>
                <Table.ColumnHeader>Status</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Actions</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data?.data.length === 0 && (
                <Table.Row>
                  <Table.Cell colSpan={5} textAlign="center" color="fg.muted">
                    No products found
                  </Table.Cell>
                </Table.Row>
              )}
              {data?.data.map((p) => (
                <Table.Row key={p.id}>
                  <Table.Cell>
                    <HStack gap="3">
                      <ProductImage src={p.imageUrl} alt={p.name} size="12" />
                      <Stack gap="0">
                        <Text fontWeight="medium">{p.name}</Text>
                        <Text fontSize="xs" color="fg.muted" fontFamily="mono">
                          {p.id}
                        </Text>
                      </Stack>
                    </HStack>
                  </Table.Cell>
                  <Table.Cell textAlign="end">{formatMoney(p.price)}</Table.Cell>
                  <Table.Cell textAlign="end">
                    {p.stockQuantity === 0 ? <Badge colorPalette="red">0</Badge> : p.stockQuantity}
                  </Table.Cell>
                  <Table.Cell>
                    <Badge colorPalette={p.isActive ? "green" : "gray"}>{p.isActive ? "Active" : "Inactive"}</Badge>
                  </Table.Cell>
                  <Table.Cell textAlign="end">
                    <HStack justify="flex-end" gap="1">
                      <Button size="xs" variant="ghost" onClick={() => setStocking(p)}>
                        Stock
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                      {p.isActive ? (
                        <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setDeactivating(p)}>
                          Deactivate
                        </Button>
                      ) : (
                        <Button size="xs" variant="ghost" colorPalette="green" loading={busyId === p.id} onClick={() => reactivate(p)}>
                          Reactivate
                        </Button>
                      )}
                    </HStack>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}

      {data && <Pagination page={data.page} limit={data.limit} total={data.total} onChange={setPage} />}

      {creating && <ProductFormDialog onClose={() => setCreating(false)} onSaved={saved("Product created")} />}
      {editing && <ProductFormDialog product={editing} onClose={() => setEditing(null)} onSaved={saved("Product updated")} />}
      {stocking && <StockDialog product={stocking} onClose={() => setStocking(null)} onSaved={saved("Stock updated")} />}

      <ConfirmDialog
        open={Boolean(deactivating)}
        title="Deactivate product?"
        confirmLabel="Deactivate"
        loading={busyId === deactivating?.id}
        onConfirm={deactivate}
        onCancel={() => setDeactivating(null)}
      >
        “{deactivating?.name}” will be hidden from customers. Past orders keep referring to it, and you can reactivate it later.
      </ConfirmDialog>
    </>
  );
}
