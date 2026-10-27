import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Box, Link, NativeSelect, Skeleton, Stack, Table, Text } from "@chakra-ui/react";
import { ordersApi } from "../api/orders";
import { ORDER_STATUSES, type OrderStatus } from "../api/types";
import { useFetch } from "../hooks/useFetch";
import { useAuth } from "../context/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { ErrorAlert } from "../components/ErrorAlert";
import { Pagination } from "../components/Pagination";
import { StatusBadge } from "../components/StatusBadge";
import { formatDate, formatMoney, shortId } from "../lib/format";
import { statusLabel } from "../theme";

const LIMIT = 15;

export function OrdersPage() {
  const { isAdmin } = useAuth();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<OrderStatus | "">("");

  const { data, error, loading, reload } = useFetch(
    (signal) => ordersApi.list({ status, page, limit: LIMIT }, signal),
    [status, page]
  );

  return (
    <>
      <PageHeader
        title={isAdmin ? "All orders" : "Your orders"}
        subtitle={isAdmin ? "Every customer's orders" : undefined}
        actions={
          <NativeSelect.Root w="56">
            <NativeSelect.Field
              aria-label="Filter by status"
              value={status}
              onChange={(e) => {
                setPage(1);
                setStatus(e.target.value as OrderStatus | "");
              }}
            >
              <option value="">All statuses</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel[s]}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        }
      />

      <ErrorAlert error={error} onRetry={reload} title="Couldn't load orders" />

      {loading && !data ? (
        <Stack gap="2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} height="10" />
          ))}
        </Stack>
      ) : data && data.data.length === 0 ? (
        <Box textAlign="center" py="16" color="fg.muted">
          <Text>No orders{status ? ` with status “${statusLabel[status]}”` : " yet"}.</Text>
        </Box>
      ) : (
        <Table.ScrollArea borderWidth="1px" rounded="md" bg="bg" opacity={loading ? 0.6 : 1}>
          <Table.Root interactive>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Order</Table.ColumnHeader>
                <Table.ColumnHeader>Placed</Table.ColumnHeader>
                {isAdmin && <Table.ColumnHeader>Customer</Table.ColumnHeader>}
                <Table.ColumnHeader>Items</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Total</Table.ColumnHeader>
                <Table.ColumnHeader>Status</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data?.data.map((o) => (
                <Table.Row key={o.id}>
                  <Table.Cell>
                    <Link asChild color="brand.fg" fontFamily="mono">
                      <RouterLink to={`/orders/${o.id}`}>#{shortId(o.id)}</RouterLink>
                    </Link>
                  </Table.Cell>
                  <Table.Cell>{formatDate(o.createdAt)}</Table.Cell>
                  {isAdmin && <Table.Cell fontFamily="mono" fontSize="xs">{o.userId}</Table.Cell>}
                  <Table.Cell>{o.items.reduce((n, i) => n + i.quantity, 0)}</Table.Cell>
                  <Table.Cell textAlign="end">{formatMoney(o.totalAmount, o.currency)}</Table.Cell>
                  <Table.Cell>
                    <StatusBadge status={o.status} />
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}

      {data && <Pagination page={data.page} limit={data.limit} total={data.total} onChange={setPage} />}
    </>
  );
}
