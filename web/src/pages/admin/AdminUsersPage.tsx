import { useState, type FormEvent } from "react";
import { Badge, Button, HStack, Input, NativeSelect, Skeleton, Stack, Table, Text } from "@chakra-ui/react";
import { usersApi } from "../../api/users";
import type { Role, User } from "../../api/types";
import { useFetch } from "../../hooks/useFetch";
import { useAuth } from "../../context/AuthContext";
import { PageHeader } from "../../components/PageHeader";
import { ErrorAlert } from "../../components/ErrorAlert";
import { Pagination } from "../../components/Pagination";
import { formatDate } from "../../lib/format";
import { notifyError, notifySuccess } from "../../components/ui/toaster";

const LIMIT = 20;

export function AdminUsersPage() {
  const { user: me } = useAuth();
  const [page, setPage] = useState(1);
  const [input, setInput] = useState("");
  const [email, setEmail] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, error, loading, reload } = useFetch(
    (signal) => usersApi.list({ page, limit: LIMIT, email }, signal),
    [page, email]
  );

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setEmail(input.trim());
  };

  const patch = async (u: User, change: { isActive?: boolean; role?: Role }, message: string) => {
    setBusyId(u.id);
    try {
      await usersApi.update(u.id, change);
      notifySuccess(message, u.email);
      reload();
    } catch (err) {
      notifyError("Couldn't update user", err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader title="Users" subtitle="Roles and account status" />

      <form onSubmit={onSearch}>
        <HStack mb="4">
          <Input type="email" placeholder="Find by exact email" value={input} onChange={(e) => setInput(e.target.value)} w="72" />
          <Button type="submit" variant="outline">
            Find
          </Button>
          {email && (
            <Button
              variant="ghost"
              onClick={() => {
                setInput("");
                setEmail("");
                setPage(1);
              }}
            >
              Clear
            </Button>
          )}
        </HStack>
      </form>

      <ErrorAlert error={error} onRetry={reload} title="Couldn't load users" />

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
                <Table.ColumnHeader>User</Table.ColumnHeader>
                <Table.ColumnHeader>Role</Table.ColumnHeader>
                <Table.ColumnHeader>Status</Table.ColumnHeader>
                <Table.ColumnHeader>Joined</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Actions</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data?.data.length === 0 && (
                <Table.Row>
                  <Table.Cell colSpan={5} textAlign="center" color="fg.muted">
                    No users found
                  </Table.Cell>
                </Table.Row>
              )}
              {data?.data.map((u) => {
                const self = u.id === me?.id; // the API refuses self-changes
                return (
                  <Table.Row key={u.id}>
                    <Table.Cell>
                      <Text fontWeight="medium">
                        {u.name} {self && <Badge ms="1">you</Badge>}
                      </Text>
                      <Text fontSize="sm" color="fg.muted">{u.email}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      <NativeSelect.Root size="sm" w="32" disabled={self || busyId === u.id}>
                        <NativeSelect.Field
                          aria-label={`Role for ${u.email}`}
                          value={u.role}
                          onChange={(e) => patch(u, { role: e.target.value as Role }, "Role updated")}
                        >
                          <option value="customer">customer</option>
                          <option value="admin">admin</option>
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge colorPalette={u.isActive ? "green" : "gray"}>{u.isActive ? "Active" : "Deactivated"}</Badge>
                    </Table.Cell>
                    <Table.Cell>{formatDate(u.createdAt)}</Table.Cell>
                    <Table.Cell textAlign="end">
                      <Button
                        size="xs"
                        variant="outline"
                        colorPalette={u.isActive ? "red" : "green"}
                        disabled={self}
                        loading={busyId === u.id}
                        onClick={() =>
                          patch(u, { isActive: !u.isActive }, u.isActive ? "User deactivated" : "User reactivated")
                        }
                      >
                        {u.isActive ? "Deactivate" : "Reactivate"}
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}

      {data && <Pagination page={data.page} limit={data.limit} total={data.total} onChange={setPage} />}
    </>
  );
}
