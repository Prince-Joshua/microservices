import { Button, HStack, Text } from "@chakra-ui/react";

export function Pagination({
  page,
  limit,
  total,
  onChange,
}: {
  page: number;
  limit: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (total <= limit) return null;

  return (
    <HStack justify="center" gap="4" mt="6">
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </Button>
      <Text fontSize="sm" color="fg.muted">
        Page {page} of {pages} · {total} total
      </Text>
      <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        Next
      </Button>
    </HStack>
  );
}
