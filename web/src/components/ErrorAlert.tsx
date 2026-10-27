import { Alert, Button } from "@chakra-ui/react";
import { errorMessage } from "../api/http";

export function ErrorAlert({
  error,
  onRetry,
  title = "Something went wrong",
}: {
  error: Error | null | undefined;
  onRetry?: () => void;
  title?: string;
}) {
  if (!error) return null;
  return (
    <Alert.Root status="error" mb="4">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>{errorMessage(error)}</Alert.Description>
      </Alert.Content>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </Alert.Root>
  );
}
