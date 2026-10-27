import { Link as RouterLink } from "react-router-dom";
import { Button, Heading, Stack, Text } from "@chakra-ui/react";

export function NotFoundPage() {
  return (
    <Stack align="center" py="16" gap="3">
      <Heading size="3xl">404</Heading>
      <Text color="fg.muted">That page doesn't exist.</Text>
      <Button asChild colorPalette="brand">
        <RouterLink to="/">Back to products</RouterLink>
      </Button>
    </Stack>
  );
}
