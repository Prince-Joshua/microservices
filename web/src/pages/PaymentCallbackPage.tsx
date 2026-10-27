import { useEffect, useState } from "react";
import { Link as RouterLink, Navigate, useSearchParams } from "react-router-dom";
import { Alert, Button, HStack, Spinner, Stack, Text } from "@chakra-ui/react";
import { ordersApi } from "../api/orders";
import { errorMessage } from "../api/http";
import type { Order } from "../api/types";
import { PENDING_ORDER_KEY } from "../lib/storage";
import { PageHeader } from "../components/PageHeader";

const MAX_ATTEMPTS = 6;

/**
 * Paystack sends the customer here (?reference=...&trxref=...) after checkout.
 * We never trust the redirect: we ask the orders service, which asks Paystack.
 */
export function PaymentCallbackPage() {
  const [params] = useSearchParams();
  const reference = params.get("reference") ?? params.get("trxref");

  // Remember which order we sent the customer to pay for.
  const [orderId] = useState(() => {
    try {
      return sessionStorage.getItem(PENDING_ORDER_KEY);
    } catch {
      return null;
    }
  });

  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;

    ordersApi
      .verifyPayment(orderId)
      .then((updated) => {
        if (cancelled) return;
        setOrder(updated);
        setError(null);
        if (updated.status === "AWAITING_PAYMENT") {
          if (attempt < MAX_ATTEMPTS) setTimeout(() => !cancelled && setAttempt((n) => n + 1), 3000);
        } else {
          try {
            sessionStorage.removeItem(PENDING_ORDER_KEY);
          } catch {
            /* ignore */
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err));
        if (attempt < MAX_ATTEMPTS) setTimeout(() => !cancelled && setAttempt((n) => n + 1), 5000);
      });

    return () => {
      cancelled = true;
    };
  }, [orderId, attempt]);

  if (!orderId) return <Navigate to="/orders" replace />;

  const settled = order && order.status !== "AWAITING_PAYMENT";
  const gaveUp = attempt >= MAX_ATTEMPTS && !settled;

  return (
    <>
      <PageHeader title="Payment" subtitle={reference ? `Reference ${reference}` : undefined} />

      <Stack gap="4" maxW="xl">
        {!settled && !gaveUp && (
          <HStack gap="3">
            <Spinner color="brand.solid" />
            <Text>Confirming your payment with Paystack…</Text>
          </HStack>
        )}

        {error && !settled && (
          <Alert.Root status="warning">
            <Alert.Indicator />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        )}

        {order?.status === "CONFIRMED" && (
          <Alert.Root status="success">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Payment received</Alert.Title>
              <Alert.Description>Your order is confirmed.</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        {order?.status === "FULFILLED" && (
          <Alert.Root status="success">
            <Alert.Indicator />
            <Alert.Title>Your order is paid and fulfilled.</Alert.Title>
          </Alert.Root>
        )}
        {(order?.status === "CANCELLED" || order?.status === "FAILED") && (
          <Alert.Root status="error">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>This order is no longer active</Alert.Title>
              <Alert.Description>
                If you were charged, the payment is refunded automatically.
              </Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}

        {gaveUp && (
          <Alert.Root status="info">
            <Alert.Indicator />
            <Alert.Description>
              We haven't seen the payment yet. It can take a minute; the order page will update once it lands.
            </Alert.Description>
          </Alert.Root>
        )}

        <HStack>
          <Button asChild colorPalette="brand">
            <RouterLink to={`/orders/${orderId}`}>View order</RouterLink>
          </Button>
          {gaveUp && (
            <Button variant="outline" onClick={() => setAttempt(0)}>
              Check again
            </Button>
          )}
        </HStack>
      </Stack>
    </>
  );
}
