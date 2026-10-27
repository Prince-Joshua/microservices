import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Center, Spinner } from "@chakra-ui/react";
import { useAuth } from "../context/AuthContext";
import { ErrorAlert } from "./ErrorAlert";

export function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, isAdmin, loading, unreachable } = useAuth();
  const location = useLocation();

  // Still finding out whether the browser holds a session: don't send anyone to the sign-in page yet.
  if (loading) {
    return (
      <Center py="20">
        <Spinner color="brand.solid" />
      </Center>
    );
  }

  // The server didn't answer, so we can't tell: signed out would be a guess.
  if (!user && unreachable) {
    return (
      <ErrorAlert
        error={new Error("Couldn't reach the server to check your session. Check your connection and try again.")}
        title="Can't check your session"
        onRetry={() => window.location.reload()}
      />
    );
  }

  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (admin && !isAdmin) return <Navigate to="/" replace />;

  return <>{children}</>;
}
