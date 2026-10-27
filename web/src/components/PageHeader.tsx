import type { ReactNode } from "react";
import { Flex, Heading, Text } from "@chakra-ui/react";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <Flex justify="space-between" align={{ base: "start", md: "center" }} gap="3" wrap="wrap" mb="6">
      <div>
        <Heading size="2xl">{title}</Heading>
        {subtitle && (
          <Text color="fg.muted" mt="1">
            {subtitle}
          </Text>
        )}
      </div>
      {actions}
    </Flex>
  );
}
