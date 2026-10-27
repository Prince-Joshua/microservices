import { Badge } from "@chakra-ui/react";
import type { OrderStatus } from "../api/types";
import { statusLabel, statusPalette } from "../theme";

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <Badge colorPalette={statusPalette[status]} variant="subtle" size="md">
      {statusLabel[status] ?? status}
    </Badge>
  );
}
