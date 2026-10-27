import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Alert, Box, Button, Flex, HStack, Input, Separator, Stack, Table, Text } from "@chakra-ui/react";
import { useCart } from "../context/CartContext";
import { useAuth } from "../context/AuthContext";
import { ordersApi } from "../api/orders";
import { ApiError, errorMessage } from "../api/http";
import { PageHeader } from "../components/PageHeader";
import { formatMoney } from "../lib/format";
import { PENDING_ORDER_KEY } from "../lib/storage";
import { toaster } from "../components/ui/toaster";

export function CartPage() {
  const { lines, total, checkoutKey, setQuantity, remove, clear, resetKey } = useCart();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkout = async () => {
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await ordersApi.create(
        lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        checkoutKey
      );
      const order = data.order;

      // 201/200: placed. 202: the saga is still running; the order page keeps polling.
      if (order) {
        clear();
        try {
          sessionStorage.setItem(PENDING_ORDER_KEY, order.id);
        } catch {
          /* ignore */
        }
      }

      if (status === 202 || !order) {
        toaster.create({ type: "info", title: "Order is being processed", description: "We'll show its status shortly." });
        navigate(order ? `/orders/${order.id}` : "/orders");
        return;
      }

      const url = data.payment?.authorizationUrl;
      if (url) {
        // Off to Paystack; it sends the customer back to /payment/callback.
        window.location.assign(url);
        return;
      }

      toaster.create({
        type: "warning",
        title: "Order created",
        description: data.paymentNote ?? "Open the order and choose “Pay now” to get a payment link.",
      });
      navigate(`/orders/${order.id}`);
    } catch (err) {
      setError(errorMessage(err));
      // A 4xx means the attempt was rolled back and that key is spent. Network/5xx: keep the key so a retry is safe.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) resetKey();
    } finally {
      setBusy(false);
    }
  };

  if (lines.length === 0) {
    return (
      <>
        <PageHeader title="Your cart" />
        <Box textAlign="center" py="16" color="fg.muted">
          <Text mb="4">Your cart is empty.</Text>
          <Button asChild colorPalette="brand">
            <RouterLink to="/">Browse products</RouterLink>
          </Button>
        </Box>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Your cart" actions={<Button variant="ghost" onClick={clear}>Clear cart</Button>} />

      {error && (
        <Alert.Root status="error" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Checkout failed</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <Table.ScrollArea borderWidth="1px" rounded="md" bg="bg">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Product</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="end">Price</Table.ColumnHeader>
              <Table.ColumnHeader>Quantity</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="end">Subtotal</Table.ColumnHeader>
              <Table.ColumnHeader />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {lines.map((l) => (
              <Table.Row key={l.productId}>
                <Table.Cell fontWeight="medium">{l.name}</Table.Cell>
                <Table.Cell textAlign="end">{formatMoney(l.price)}</Table.Cell>
                <Table.Cell>
                  <Input
                    type="number"
                    min={1}
                    max={l.maxQuantity}
                    w="20"
                    size="sm"
                    value={l.quantity}
                    onChange={(e) => setQuantity(l.productId, Number(e.target.value))}
                  />
                </Table.Cell>
                <Table.Cell textAlign="end">{formatMoney(l.price * l.quantity)}</Table.Cell>
                <Table.Cell textAlign="end">
                  <Button size="xs" variant="ghost" colorPalette="red" onClick={() => remove(l.productId)}>
                    Remove
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Table.ScrollArea>

      <Flex justify="flex-end" mt="6">
        <Stack gap="3" minW={{ base: "full", md: "80" }}>
          <HStack justify="space-between">
            <Text fontWeight="semibold">Total</Text>
            <Text fontSize="xl" fontWeight="bold">{formatMoney(total)}</Text>
          </HStack>
          <Separator />
          {user ? (
            <Button colorPalette="brand" size="lg" loading={busy} onClick={checkout}>
              Place order & pay
            </Button>
          ) : (
            <Button asChild colorPalette="brand" size="lg">
              <RouterLink to="/login" state={{ from: "/cart" }}>Sign in to checkout</RouterLink>
            </Button>
          )}
          <Text fontSize="xs" color="fg.muted">
            Stock is held for you while you pay. You'll be redirected to Paystack to complete payment.
          </Text>
        </Stack>
      </Flex>
    </>
  );
}
