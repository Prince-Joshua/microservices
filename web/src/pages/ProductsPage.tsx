import { useState, type FormEvent } from "react";
import { Badge, Box, Button, Card, HStack, Input, SimpleGrid, Skeleton, Text } from "@chakra-ui/react";
import { productsApi } from "../api/products";
import type { Product } from "../api/types";
import { useFetch } from "../hooks/useFetch";
import { useCart } from "../context/CartContext";
import { PageHeader } from "../components/PageHeader";
import { ErrorAlert } from "../components/ErrorAlert";
import { Pagination } from "../components/Pagination";
import { ProductImage } from "../components/ProductImage";
import { formatMoney } from "../lib/format";
import { toaster } from "../components/ui/toaster";

const LIMIT = 12;

function StockBadge({ stock }: { stock: number }) {
  if (stock <= 0) return <Badge colorPalette="red">Sold out</Badge>;
  if (stock <= 5) return <Badge colorPalette="orange">Only {stock} left</Badge>;
  return <Badge colorPalette="green">In stock</Badge>;
}

function ProductCard({ product }: { product: Product }) {
  const { add, lines } = useCart();
  const inCart = lines.find((l) => l.productId === product.id)?.quantity ?? 0;
  const soldOut = product.stockQuantity <= 0;
  const maxed = inCart >= product.stockQuantity;

  return (
    <Card.Root overflow="hidden">
      <ProductImage src={product.imageUrl} alt={product.name} rounded="none" />
      <Card.Body gap="2">
        <Card.Title>{product.name}</Card.Title>
        <Text fontSize="xl" fontWeight="semibold" color="brand.fg">
          {formatMoney(product.price)}
        </Text>
        <HStack>
          <StockBadge stock={product.stockQuantity} />
          {inCart > 0 && <Badge variant="outline">{inCart} in cart</Badge>}
        </HStack>
      </Card.Body>
      <Card.Footer>
        <Button
          colorPalette="brand"
          width="full"
          disabled={soldOut || maxed}
          onClick={() => {
            add(product);
            toaster.create({ type: "success", title: "Added to cart", description: product.name, duration: 1800 });
          }}
        >
          {soldOut ? "Unavailable" : maxed ? "Max in cart" : "Add to cart"}
        </Button>
      </Card.Footer>
    </Card.Root>
  );
}

export function ProductsPage() {
  const [page, setPage] = useState(1);
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");

  const { data, error, loading, reload } = useFetch(
    (signal) => productsApi.list({ q, page, limit: LIMIT }, signal),
    [q, page]
  );

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setQ(input.trim());
  };

  return (
    <>
      <PageHeader
        title="Products"
        subtitle="Browse what's in stock"
        actions={
          <form onSubmit={onSearch}>
            <HStack>
              <Input placeholder="Search products" value={input} onChange={(e) => setInput(e.target.value)} w={{ base: "full", md: "64" }} />
              <Button type="submit" variant="outline">
                Search
              </Button>
            </HStack>
          </form>
        }
      />

      <ErrorAlert error={error} onRetry={reload} title="Couldn't load products" />

      {loading && !data ? (
        <SimpleGrid columns={{ base: 1, sm: 2, lg: 4 }} gap="4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} height="72" />
          ))}
        </SimpleGrid>
      ) : data && data.data.length === 0 ? (
        <Box textAlign="center" py="16" color="fg.muted">
          No products found{q ? ` for "${q}"` : ""}.
        </Box>
      ) : (
        <SimpleGrid columns={{ base: 1, sm: 2, lg: 4 }} gap="4" opacity={loading ? 0.6 : 1}>
          {data?.data.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </SimpleGrid>
      )}

      {data && <Pagination page={data.page} limit={data.limit} total={data.total} onChange={setPage} />}
    </>
  );
}
