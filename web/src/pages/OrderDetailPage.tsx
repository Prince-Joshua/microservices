import { useEffect, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import { Alert, Box, Button, Card, DataList, HStack, Skeleton, Stack, Table, Text } from "@chakra-ui/react";
import { ordersApi } from "../api/orders";
import { ApiError } from "../api/http";
import type { Order } from "../api/types";
import { useFetch } from "../hooks/useFetch";
import { useAuth } from "../context/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { ErrorAlert } from "../components/ErrorAlert";
import { StatusBadge } from "../components/StatusBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { formatDate, formatMoney, shortId } from "../lib/format";
import { PENDING_ORDER_KEY } from "../lib/storage";
import { notifyError, notifySuccess, toaster } from "../components/ui/toaster";

type Action = "pay" | "verify" | "cancel" | "fulfill";

export function OrderDetailPage() {
  const { id = "" } = useParams();
  const { isAdmin } = useAuth();
  const { data: order, error, loading, reload, setData } = useFetch((s) => ordersApi.get(id, s), [id]);

  const [busy, setBusy] = useState<Action | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // While the stock saga is still running, keep checking.
  useEffect(() => {
    if (order?.status !== "PENDING") return;
    const t = setTimeout(reload, 3000);
    return () => clearTimeout(t);
  }, [order, reload]);

  const run = async (action: Action, fn: () => Promise<Order | void>, success?: string) => {
    setBusy(action);
    try {
      const updated = await fn();
      if (updated) setData(updated);
      if (success) notifySuccess(success);
    } catch (err) {
      notifyError("Action failed", err);
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) reload();
    } finally {
      setBusy(null);
    }
  };

  const pay = () =>
    run("pay", async () => {
      const res = await ordersApi.pay(id);
      const url = res.payment?.authorizationUrl;
      if (url) {
        try {
          sessionStorage.setItem(PENDING_ORDER_KEY, id);
        } catch {
          /* ignore */
        }
        window.location.assign(url);
        return;
      }
      toaster.create({ type: "info", title: res.message ?? "No payment link available" });
      return res.order;
    });

  const verify = () =>
    run("verify", async () => {
      const updated = await ordersApi.verifyPayment(id);
      toaster.create({
        type: updated.status === "CONFIRMED" ? "success" : "info",
        title: updated.status === "CONFIRMED" ? "Payment confirmed" : "Payment not confirmed yet",
        description: updated.status === "CONFIRMED" ? undefined : "If you've just paid, try again in a few seconds.",
      });
      return updated;
    });

  const cancel = async () => {
    await run("cancel", () => ordersApi.cancel(id), "Order cancelled");
    setConfirmCancel(false);
  };

  const fulfill = () => run("fulfill", () => ordersApi.fulfill(id), "Order marked as fulfilled");

  if (loading && !order) return <Skeleton height="64" />;

  if (error && !order) {
    return (
      <>
        <ErrorAlert
          error={error}
          onRetry={reload}
          title={error instanceof ApiError && error.status === 404 ? "Order not found" : "Couldn't load order"}
        />
        <Button asChild variant="outline">
          <RouterLink to="/orders">Back to orders</RouterLink>
        </Button>
      </>
    );
  }
  if (!order) return null;

  const awaiting = order.status === "AWAITING_PAYMENT";
  const paid = order.status === "CONFIRMED";

  return (
    <>
      <PageHeader
        title={`Order #${shortId(order.id)}`}
        subtitle={`Placed ${formatDate(order.createdAt)}`}
        actions={<StatusBadge status={order.status} />}
      />

      {order.status === "PENDING" && (
        <Alert.Root status="info" mb="4">
          <Alert.Indicator />
          <Alert.Title>Reserving your stock… this page updates automatically.</Alert.Title>
        </Alert.Root>
      )}
      {awaiting && (
        <Alert.Root status="warning" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Waiting for payment</Alert.Title>
            <Alert.Description>
              Pay before {formatDate(order.paymentDueAt)} or the order is cancelled and the stock goes back on sale.
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {order.status === "FAILED" && (
        <Alert.Root status="error" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>This order couldn't be placed</Alert.Title>
            {order.failureReason && <Alert.Description>{order.failureReason}</Alert.Description>}
          </Alert.Content>
        </Alert.Root>
      )}
      {order.status === "CANCELLED" && (
        <Alert.Root status="neutral" mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Order cancelled</Alert.Title>
            <Alert.Description>
              {order.cancelReason ? `${order.cancelReason}. ` : ""}
              {order.paidAt ? "Your payment is being refunded." : "Any held stock was released."}
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      <Stack gap="6">
        <Table.ScrollArea borderWidth="1px" rounded="md" bg="bg">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Product</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Unit price</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Qty</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Subtotal</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {order.items.length === 0 ? (
                <Table.Row>
                  <Table.Cell colSpan={4} textAlign="center" color="fg.muted">
                    No items recorded yet
                  </Table.Cell>
                </Table.Row>
              ) : (
                order.items.map((i) => (
                  <Table.Row key={i.id}>
                    <Table.Cell>{i.productName}</Table.Cell>
                    <Table.Cell textAlign="end">{formatMoney(i.unitPrice, order.currency)}</Table.Cell>
                    <Table.Cell textAlign="end">{i.quantity}</Table.Cell>
                    <Table.Cell textAlign="end">
                      {formatMoney(Number(i.unitPrice) * i.quantity, order.currency)}
                    </Table.Cell>
                  </Table.Row>
                ))
              )}
            </Table.Body>
            <Table.Footer>
              <Table.Row>
                <Table.Cell colSpan={3} textAlign="end" fontWeight="semibold">
                  Total
                </Table.Cell>
                <Table.Cell textAlign="end" fontWeight="bold">
                  {formatMoney(order.totalAmount, order.currency)}
                </Table.Cell>
              </Table.Row>
            </Table.Footer>
          </Table.Root>
        </Table.ScrollArea>

        <Card.Root>
          <Card.Body>
            <DataList.Root orientation="horizontal" divideY="1px" gap="3">
              <DataList.Item>
                <DataList.ItemLabel>Order ID</DataList.ItemLabel>
                <DataList.ItemValue fontFamily="mono" fontSize="sm">{order.id}</DataList.ItemValue>
              </DataList.Item>
              {isAdmin && (
                <DataList.Item>
                  <DataList.ItemLabel>Customer</DataList.ItemLabel>
                  <DataList.ItemValue fontFamily="mono" fontSize="sm">{order.userId}</DataList.ItemValue>
                </DataList.Item>
              )}
              <DataList.Item>
                <DataList.ItemLabel>Paid</DataList.ItemLabel>
                <DataList.ItemValue>{formatDate(order.paidAt)}</DataList.ItemValue>
              </DataList.Item>
              {order.paymentReference && (
                <DataList.Item>
                  <DataList.ItemLabel>Payment reference</DataList.ItemLabel>
                  <DataList.ItemValue fontFamily="mono" fontSize="sm">{order.paymentReference}</DataList.ItemValue>
                </DataList.Item>
              )}
              {order.cancelledAt && (
                <DataList.Item>
                  <DataList.ItemLabel>Cancelled</DataList.ItemLabel>
                  <DataList.ItemValue>{formatDate(order.cancelledAt)}</DataList.ItemValue>
                </DataList.Item>
              )}
            </DataList.Root>
          </Card.Body>
        </Card.Root>

        <HStack gap="3" wrap="wrap">
          {awaiting && (
            <>
              <Button colorPalette="brand" onClick={pay} loading={busy === "pay"}>
                Pay now
              </Button>
              <Button variant="outline" onClick={verify} loading={busy === "verify"}>
                I've paid — check status
              </Button>
            </>
          )}
          {paid && isAdmin && (
            <Button colorPalette="green" onClick={fulfill} loading={busy === "fulfill"}>
              Mark as fulfilled
            </Button>
          )}
          {(awaiting || paid) && (
            <Button variant="outline" colorPalette="red" onClick={() => setConfirmCancel(true)}>
              Cancel order
            </Button>
          )}
          <Button asChild variant="ghost">
            <RouterLink to="/orders">Back to orders</RouterLink>
          </Button>
        </HStack>
        {paid && (
          <Box>
            <Text fontSize="sm" color="fg.muted">
              Paid orders can be cancelled until they're fulfilled; the payment is refunded automatically.
            </Text>
          </Box>
        )}
      </Stack>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this order?"
        confirmLabel="Cancel order"
        loading={busy === "cancel"}
        onConfirm={cancel}
        onCancel={() => setConfirmCancel(false)}
      >
        {paid
          ? "The stock goes back on sale and your payment is refunded."
          : "The held stock goes back on sale. You haven't been charged."}
      </ConfirmDialog>
    </>
  );
}
